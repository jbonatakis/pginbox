import { createHash, randomInt } from "node:crypto";
import { Kysely, sql, type Transaction } from "kysely";
import { db as defaultDb } from "../../db";
import type { DB } from "../../types/db.d.ts";
import {
  FastmailJmapClient,
  FastmailJmapError,
  type FastmailPushEvent,
  type MailboxQueryPage,
  type ResolvedTrackedMailbox,
  type TrackedMailboxRecord,
} from "./fastmail-jmap";
import {
  parseMessageWithPython,
  type ParsedMessageAttachment,
  type ParsedMessageRecord,
} from "./python-message-parser";

const JOB_NAME = "mailbox:ingest";
const THREAD_STABLE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const THREAD_STABLE_ID_LENGTH = 10;
const PENDING_RECEIPT_STATUSES = ["fetched", "parsed", "parse_failed", "store_failed"] as const;

type DatabaseClient = Kysely<DB> | Transaction<DB>;

type Logger = Pick<typeof console, "error" | "info" | "warn">;

interface TrackedListRow {
  id: number;
  name: string;
  source_folder: string;
}

interface MailboxSyncStateRow {
  email_query_state: string | null;
  last_push_event_id: string | null;
  list_id: number;
  mailbox_id: string;
  source_folder: string;
}

interface MailboxReceiptRow {
  attempt_count: number;
  blob_id: string;
  id: string;
  jmap_email_id: string;
  list_id: number;
  mailbox_id: string;
  parsed_message_id: string | null;
  raw_rfc822: Buffer;
  source_folder: string;
  status: string;
}

export interface MailboxIngestRuntimeConfig {
  apiToken: string;
  parserBin: string;
  pushPingSeconds: number;
  queryPageSize: number;
  receiptBatchSize: number;
  sessionUrl: string;
  syncDebounceMs: number;
}

export interface MailboxSyncResult {
  changedFolders: number;
  processedReceipts: number;
  stagedReceipts: number;
}

export interface MailboxIngestServiceDependencies {
  db?: Kysely<DB>;
  fastmailClient?: FastmailJmapClient;
  logger?: Logger;
  now?: () => Date;
  parseMessage?: (options: {
    archiveMonth?: string | null;
    listId: number;
    pythonBin: string;
    rawRfc822: Uint8Array;
  }) => Promise<ParsedMessageRecord>;
  runtime: MailboxIngestRuntimeConfig;
}

function logLine(parts: Array<string | number | null | undefined>): string {
  return [`[${JOB_NAME}]`, ...parts.filter((part) => part != null && part !== "")].join(" ");
}

function hashRawMessage(rawRfc822: Uint8Array): string {
  return createHash("sha256").update(rawRfc822).digest("hex");
}

function generateStableThreadId(): string {
  let value = "";
  for (let index = 0; index < THREAD_STABLE_ID_LENGTH; index += 1) {
    value += THREAD_STABLE_ID_ALPHABET[randomInt(THREAD_STABLE_ID_ALPHABET.length)];
  }
  return value;
}

export function shouldIgnorePushEvent(event: FastmailPushEvent): boolean {
  if (!event.data) {
    return true;
  }

  try {
    const parsed = JSON.parse(event.data) as { type?: unknown };
    return parsed.type === "connect";
  } catch {
    return false;
  }
}

async function fetchTrackedLists(database: Kysely<DB>): Promise<TrackedListRow[]> {
  return database
    .selectFrom("lists")
    .select(["id", "name", "source_folder"])
    .where("tracked", "=", true)
    .where("source_folder", "is not", null)
    .orderBy("id", "asc")
    .execute() as Promise<TrackedListRow[]>;
}

async function fetchExistingThreadByMessageId(
  trx: Transaction<DB>,
  messageId: string | null,
): Promise<{ list_id: number; thread_id: string } | null> {
  if (!messageId) {
    return null;
  }

  const row = await trx
    .selectFrom("messages")
    .select(["list_id", "thread_id"])
    .where("message_id", "=", messageId)
    .executeTakeFirst();
  return row ?? null;
}

async function fetchExistingReferenceThread(
  trx: Transaction<DB>,
  refs: readonly string[] | null,
): Promise<{ list_id: number; thread_id: string } | null> {
  if (!refs || refs.length === 0) {
    return null;
  }

  const rows = await trx
    .selectFrom("messages")
    .select(["message_id", "list_id", "thread_id"])
    .where("message_id", "in", refs)
    .execute();
  const byMessageId = new Map(rows.map((row) => [row.message_id, row]));

  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const existing = byMessageId.get(refs[index]!);
    if (existing) {
      return existing;
    }
  }

  return null;
}

async function ensureStableThreadId(
  trx: Transaction<DB>,
  threadId: string,
): Promise<string> {
  const existing = await trx
    .selectFrom("threads")
    .select("id")
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  if (existing) {
    return existing.id;
  }

  while (true) {
    const candidate = generateStableThreadId();
    const owner = await trx
      .selectFrom("threads")
      .select("thread_id")
      .where("id", "=", candidate)
      .executeTakeFirst();
    if (!owner) {
      return candidate;
    }
  }
}

async function refreshTouchedThreadAggregate(
  trx: Transaction<DB>,
  threadId: string,
): Promise<void> {
  const result = await sql<{
    last_activity_at: Date | null;
    list_id: number;
    message_count: string;
    started_at: Date | null;
    subject: string | null;
    thread_id: string;
  }>`
    SELECT
      thread_id,
      list_id,
      _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST))[1]) AS subject,
      min(sent_at) AS started_at,
      max(sent_at) AS last_activity_at,
      count(*)::text AS message_count
    FROM messages
    WHERE thread_id = ${threadId}
    GROUP BY thread_id, list_id
  `.execute(trx);

  const aggregate = result.rows[0];
  if (!aggregate) {
    return;
  }

  const stableThreadId = await ensureStableThreadId(trx, aggregate.thread_id);
  await trx
    .insertInto("threads")
    .values({
      id: stableThreadId,
      last_activity_at: aggregate.last_activity_at,
      list_id: aggregate.list_id,
      message_count: Number.parseInt(aggregate.message_count, 10),
      started_at: aggregate.started_at,
      subject: aggregate.subject,
      thread_id: aggregate.thread_id,
    })
    .onConflict((oc) =>
      oc.column("thread_id").doUpdateSet({
        last_activity_at: aggregate.last_activity_at,
        list_id: aggregate.list_id,
        message_count: Number.parseInt(aggregate.message_count, 10),
        started_at: aggregate.started_at,
        subject: aggregate.subject,
      }),
    )
    .execute();
}

async function autoTrackParticipationForInsertedMessage(
  trx: Transaction<DB>,
  insertedMessageId: string,
): Promise<void> {
  await sql`
    WITH ranked_matches AS (
      SELECT
        users.id AS user_id,
        messages.thread_id AS raw_thread_id,
        threads.id AS stable_thread_id,
        messages.id AS message_id,
        row_number() OVER (
          PARTITION BY users.id, messages.thread_id
          ORDER BY messages.sent_at DESC NULLS FIRST, messages.id DESC
        ) AS rank
      FROM messages
      INNER JOIN threads
        ON threads.thread_id = messages.thread_id
      INNER JOIN user_emails
        ON lower(user_emails.email) = lower(messages.from_email)
      INNER JOIN users
        ON users.id = user_emails.user_id
      WHERE messages.id = ${insertedMessageId}
        AND users.status = 'active'
        AND user_emails.verified_at IS NOT NULL
    ),
    matched_messages AS (
      SELECT user_id, raw_thread_id, stable_thread_id, message_id
      FROM ranked_matches
      WHERE rank = 1
    )
    INSERT INTO thread_tracking (
      user_id,
      thread_id,
      anchor_message_id,
      manual_followed_at,
      participated_at,
      participation_suppressed_at,
      created_at,
      updated_at
    )
    SELECT
      matched_messages.user_id,
      matched_messages.stable_thread_id,
      matched_messages.message_id,
      NULL,
      now(),
      NULL,
      now(),
      now()
    FROM matched_messages
    ON CONFLICT (user_id, thread_id) DO UPDATE SET
      anchor_message_id = EXCLUDED.anchor_message_id,
      participated_at = COALESCE(thread_tracking.participated_at, EXCLUDED.participated_at),
      updated_at = EXCLUDED.updated_at
  `.execute(trx);

  await sql`
    WITH ranked_matches AS (
      SELECT
        users.id AS user_id,
        messages.thread_id AS raw_thread_id,
        threads.id AS stable_thread_id,
        messages.id AS message_id,
        row_number() OVER (
          PARTITION BY users.id, messages.thread_id
          ORDER BY messages.sent_at DESC NULLS FIRST, messages.id DESC
        ) AS rank
      FROM messages
      INNER JOIN threads
        ON threads.thread_id = messages.thread_id
      INNER JOIN user_emails
        ON lower(user_emails.email) = lower(messages.from_email)
      INNER JOIN users
        ON users.id = user_emails.user_id
      WHERE messages.id = ${insertedMessageId}
        AND users.status = 'active'
        AND user_emails.verified_at IS NOT NULL
    ),
    matched_messages AS (
      SELECT user_id, raw_thread_id, stable_thread_id, message_id
      FROM ranked_matches
      WHERE rank = 1
    )
    DELETE FROM thread_read_progress
    USING thread_tracking, matched_messages
    WHERE thread_read_progress.user_id = thread_tracking.user_id
      AND thread_read_progress.thread_id = thread_tracking.thread_id
      AND matched_messages.user_id = thread_tracking.user_id
      AND matched_messages.stable_thread_id = thread_tracking.thread_id
      AND thread_tracking.manual_followed_at IS NULL
      AND thread_tracking.participation_suppressed_at IS NOT NULL
  `.execute(trx);

  await sql`
    WITH ranked_matches AS (
      SELECT
        users.id AS user_id,
        messages.thread_id AS raw_thread_id,
        threads.id AS stable_thread_id,
        messages.id AS message_id,
        row_number() OVER (
          PARTITION BY users.id, messages.thread_id
          ORDER BY messages.sent_at DESC NULLS FIRST, messages.id DESC
        ) AS rank
      FROM messages
      INNER JOIN threads
        ON threads.thread_id = messages.thread_id
      INNER JOIN user_emails
        ON lower(user_emails.email) = lower(messages.from_email)
      INNER JOIN users
        ON users.id = user_emails.user_id
      WHERE messages.id = ${insertedMessageId}
        AND users.status = 'active'
        AND user_emails.verified_at IS NOT NULL
    ),
    matched_messages AS (
      SELECT user_id, raw_thread_id, stable_thread_id, message_id
      FROM ranked_matches
      WHERE rank = 1
    )
    INSERT INTO thread_read_progress (
      user_id,
      thread_id,
      last_read_message_id,
      updated_at
    )
    SELECT
      matched_messages.user_id,
      matched_messages.stable_thread_id,
      matched_messages.message_id,
      now()
    FROM matched_messages
    INNER JOIN thread_tracking
      ON thread_tracking.user_id = matched_messages.user_id
     AND thread_tracking.thread_id = matched_messages.stable_thread_id
    LEFT JOIN thread_read_progress
      ON thread_read_progress.user_id = matched_messages.user_id
     AND thread_read_progress.thread_id = matched_messages.stable_thread_id
    WHERE (
      thread_tracking.manual_followed_at IS NOT NULL
      OR thread_tracking.participation_suppressed_at IS NULL
    )
      AND thread_read_progress.user_id IS NULL
    ON CONFLICT (user_id, thread_id) DO NOTHING
  `.execute(trx);

  await sql`
    WITH ranked_matches AS (
      SELECT
        users.id AS user_id,
        messages.thread_id AS raw_thread_id,
        threads.id AS stable_thread_id,
        messages.id AS message_id,
        row_number() OVER (
          PARTITION BY users.id, messages.thread_id
          ORDER BY messages.sent_at DESC NULLS FIRST, messages.id DESC
        ) AS rank
      FROM messages
      INNER JOIN threads
        ON threads.thread_id = messages.thread_id
      INNER JOIN user_emails
        ON lower(user_emails.email) = lower(messages.from_email)
      INNER JOIN users
        ON users.id = user_emails.user_id
      WHERE messages.id = ${insertedMessageId}
        AND users.status = 'active'
        AND user_emails.verified_at IS NOT NULL
    ),
    matched_messages AS (
      SELECT user_id, raw_thread_id, stable_thread_id, message_id
      FROM ranked_matches
      WHERE rank = 1
    ),
    progress_candidates AS (
      SELECT
        matched_messages.user_id,
        matched_messages.stable_thread_id AS thread_id,
        matched_messages.raw_thread_id,
        matched_messages.message_id AS candidate_message_id,
        thread_read_progress.last_read_message_id AS existing_message_id,
        candidate_messages.sent_at AS candidate_sent_at,
        existing_messages.sent_at AS existing_sent_at,
        existing_messages.thread_id AS existing_raw_thread_id
      FROM matched_messages
      INNER JOIN thread_tracking
        ON thread_tracking.user_id = matched_messages.user_id
       AND thread_tracking.thread_id = matched_messages.stable_thread_id
      INNER JOIN thread_read_progress
        ON thread_read_progress.user_id = matched_messages.user_id
       AND thread_read_progress.thread_id = matched_messages.stable_thread_id
      INNER JOIN messages AS candidate_messages
        ON candidate_messages.id = matched_messages.message_id
      LEFT JOIN messages AS existing_messages
        ON existing_messages.id = thread_read_progress.last_read_message_id
      WHERE (
        thread_tracking.manual_followed_at IS NOT NULL
        OR thread_tracking.participation_suppressed_at IS NULL
      )
    ),
    rows_to_advance AS (
      SELECT user_id, thread_id, candidate_message_id
      FROM progress_candidates
      WHERE existing_raw_thread_id IS DISTINCT FROM raw_thread_id
         OR (
           candidate_sent_at IS NULL
           AND existing_sent_at IS NOT NULL
         )
         OR (
           candidate_sent_at IS NULL
           AND existing_sent_at IS NULL
           AND candidate_message_id > existing_message_id
         )
         OR (
           candidate_sent_at IS NOT NULL
           AND existing_sent_at IS NOT NULL
           AND (
             candidate_sent_at > existing_sent_at
             OR (
               candidate_sent_at = existing_sent_at
               AND candidate_message_id > existing_message_id
             )
           )
         )
    )
    UPDATE thread_read_progress
    SET
      last_read_message_id = rows_to_advance.candidate_message_id,
      updated_at = now()
    FROM rows_to_advance
    WHERE thread_read_progress.user_id = rows_to_advance.user_id
      AND thread_read_progress.thread_id = rows_to_advance.thread_id
  `.execute(trx);
}

async function insertAttachmentsForMessage(
  trx: Transaction<DB>,
  messageDbId: string,
  attachments: readonly ParsedMessageAttachment[],
): Promise<void> {
  for (const [partIndex, attachment] of attachments.entries()) {
    await trx
      .insertInto("attachments")
      .values({
        content: attachment.content,
        content_type: attachment.content_type,
        filename: attachment.filename,
        message_id: messageDbId,
        part_index: partIndex,
        size_bytes: attachment.size_bytes,
      })
      .onConflict((oc) => oc.columns(["message_id", "part_index"]).doNothing())
      .execute();
  }
}

export class MailboxIngestService {
  private readonly db: Kysely<DB>;
  private readonly fastmailClient: FastmailJmapClient;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly parseMessage: NonNullable<MailboxIngestServiceDependencies["parseMessage"]>;
  private readonly runtime: MailboxIngestRuntimeConfig;

  constructor(dependencies: MailboxIngestServiceDependencies) {
    this.db = dependencies.db ?? defaultDb;
    this.fastmailClient =
      dependencies.fastmailClient ??
      new FastmailJmapClient({
        apiToken: dependencies.runtime.apiToken,
        pushPingSeconds: dependencies.runtime.pushPingSeconds,
        queryPageSize: dependencies.runtime.queryPageSize,
        sessionUrl: dependencies.runtime.sessionUrl,
      });
    this.logger = dependencies.logger ?? console;
    this.now = dependencies.now ?? (() => new Date());
    this.parseMessage =
      dependencies.parseMessage ??
      ((options) =>
        parseMessageWithPython({
          archiveMonth: options.archiveMonth,
          listId: options.listId,
          pythonBin: options.pythonBin,
          rawRfc822: options.rawRfc822,
        }));
    this.runtime = dependencies.runtime;
  }

  async syncTrackedMailboxesOnce(lastPushEventId: string | null = null): Promise<MailboxSyncResult> {
    const trackedLists = await fetchTrackedLists(this.db);
    const trackedMailboxes = trackedLists.map<TrackedMailboxRecord>((list) => ({
      listId: list.id,
      listName: list.name,
      sourceFolder: list.source_folder,
    }));

    if (trackedMailboxes.length === 0) {
      this.logger.info(logLine(["tracked_mailboxes=0", "nothing_to_do=true"]));
      return { changedFolders: 0, processedReceipts: 0, stagedReceipts: 0 };
    }

    const resolvedMailboxes = await this.fastmailClient.resolveTrackedMailboxes(trackedMailboxes);
    let changedFolders = 0;
    let stagedReceipts = 0;

    for (const mailbox of resolvedMailboxes) {
      const syncState = await this.db
        .selectFrom("mailbox_sync_state")
        .select(["email_query_state", "last_push_event_id", "list_id", "mailbox_id", "source_folder"])
        .where("source_folder", "=", mailbox.sourceFolder)
        .executeTakeFirst() as MailboxSyncStateRow | undefined;

      if (!syncState?.email_query_state) {
        const initialSync = await this.#bootstrapMailbox(mailbox, lastPushEventId);
        changedFolders += initialSync.changedFolders;
        stagedReceipts += initialSync.stagedReceipts;
        continue;
      }

      try {
        const incremental = await this.#syncMailboxIncrementally(mailbox, syncState, lastPushEventId);
        changedFolders += incremental.changedFolders;
        stagedReceipts += incremental.stagedReceipts;
      } catch (error) {
        if (!(error instanceof FastmailJmapError)) {
          throw error;
        }

        this.logger.warn(
          logLine([
            `mailbox=${mailbox.sourceFolder}`,
            "falling_back_to_full_sync=true",
            `reason=${error.details.type ?? error.message}`,
          ]),
        );
        const resynced = await this.#bootstrapMailbox(mailbox, lastPushEventId);
        changedFolders += resynced.changedFolders;
        stagedReceipts += resynced.stagedReceipts;
      }
    }

    const processedReceipts = await this.processPendingReceipts(this.runtime.receiptBatchSize);
    return { changedFolders, processedReceipts, stagedReceipts };
  }

  async processPendingReceipts(batchSize = this.runtime.receiptBatchSize): Promise<number> {
    let processed = 0;

    while (true) {
      const batch = (await this.db
        .selectFrom("mailbox_receipts")
        .select([
          "attempt_count",
          "blob_id",
          "id",
          "jmap_email_id",
          "list_id",
          "mailbox_id",
          "parsed_message_id",
          "raw_rfc822",
          "source_folder",
          "status",
        ])
        .where("status", "in", [...PENDING_RECEIPT_STATUSES])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(batchSize)
        .execute()) as MailboxReceiptRow[];

      if (batch.length === 0) {
        break;
      }

      for (const receipt of batch) {
        await this.#processReceipt(receipt);
        processed += 1;
      }
    }

    return processed;
  }

  async runWorker(signal?: AbortSignal): Promise<void> {
    let reconnectDelayMs = 1000;
    let lastPushEventId: string | null = null;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let syncInFlight: Promise<void> | null = null;
    let queuedWhileRunning = false;

    const runSync = async (reason: string) => {
      this.logger.info(logLine([`sync_reason=${reason}`, "starting=true"]));
      const result = await this.syncTrackedMailboxesOnce(lastPushEventId);
      this.logger.info(
        logLine([
          `sync_reason=${reason}`,
          `changed_folders=${result.changedFolders}`,
          `staged_receipts=${result.stagedReceipts}`,
          `processed_receipts=${result.processedReceipts}`,
        ]),
      );
    };

    const queueSync = (reason: string) => {
      if (signal?.aborted) {
        return;
      }

      if (syncInFlight) {
        queuedWhileRunning = true;
        return;
      }

      if (syncTimer) {
        return;
      }

      syncTimer = setTimeout(() => {
        syncTimer = null;
        syncInFlight = runSync(reason)
          .catch((error) => {
            this.logger.error(logLine([`sync_reason=${reason}`, `failed=${String(error)}`]));
          })
          .finally(() => {
            syncInFlight = null;
            if (queuedWhileRunning) {
              queuedWhileRunning = false;
              queueSync("coalesced");
            }
          });
      }, this.runtime.syncDebounceMs);
    };

    await runSync("startup");

    while (!signal?.aborted) {
      try {
        for await (const event of this.fastmailClient.streamPushEvents(lastPushEventId)) {
          if (signal?.aborted) {
            break;
          }

          if (event.id) {
            lastPushEventId = event.id;
          }

          if (shouldIgnorePushEvent(event)) {
            continue;
          }

          queueSync("push");
        }

        if (!signal?.aborted) {
          queueSync("push_stream_closed");
        }
      } catch (error) {
        this.logger.warn(
          logLine([
            "push_stream_error=true",
            `message=${error instanceof Error ? error.message : String(error)}`,
            `reconnect_delay_ms=${reconnectDelayMs}`,
          ]),
        );
        if (signal?.aborted) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        await runSync("reconnect");
        continue;
      }

      reconnectDelayMs = 1000;
    }
  }

  async #bootstrapMailbox(
    mailbox: ResolvedTrackedMailbox,
    lastPushEventId: string | null,
  ): Promise<{ changedFolders: number; stagedReceipts: number }> {
    let position = 0;
    let stagedReceipts = 0;
    let queryState = "";

    while (true) {
      const page = await this.fastmailClient.queryMailboxPage(mailbox.mailboxId, {
        limit: this.runtime.queryPageSize,
        position,
      });
      queryState = page.queryState;
      if (page.messages.length === 0) {
        break;
      }

      stagedReceipts += await this.#stageMailboxPage(mailbox, page);
      position += page.messages.length;

      if (page.messages.length < this.runtime.queryPageSize) {
        break;
      }
    }

    await this.#upsertSyncState(mailbox, {
      emailQueryState: queryState,
      lastPushEventId,
      lastReconciledAt: this.now(),
      lastSuccessfulSyncAt: this.now(),
    });
    return { changedFolders: 1, stagedReceipts };
  }

  async #syncMailboxIncrementally(
    mailbox: ResolvedTrackedMailbox,
    syncState: MailboxSyncStateRow,
    lastPushEventId: string | null,
  ): Promise<{ changedFolders: number; stagedReceipts: number }> {
    const changes = await this.fastmailClient.queryMailboxChanges(
      mailbox.mailboxId,
      syncState.email_query_state ?? "",
    );
    const stagedReceipts = await this.#stageMailboxPage(mailbox, {
      messages: changes.messages,
      queryState: changes.queryState,
    });

    await this.#upsertSyncState(mailbox, {
      emailQueryState: changes.queryState,
      lastPushEventId,
      lastReconciledAt: null,
      lastSuccessfulSyncAt: this.now(),
    });

    return {
      changedFolders: changes.messages.length > 0 ? 1 : 0,
      stagedReceipts,
    };
  }

  async #stageMailboxPage(mailbox: ResolvedTrackedMailbox, page: MailboxQueryPage): Promise<number> {
    let stagedReceipts = 0;

    for (const message of page.messages) {
      const rawRfc822 = await this.fastmailClient.downloadMessageBlob(message.blobId);
      const insertResult = await this.db
        .insertInto("mailbox_receipts")
        .values({
          blob_id: message.blobId,
          internal_date: message.receivedAt,
          jmap_email_id: message.id,
          list_id: mailbox.listId,
          mailbox_id: mailbox.mailboxId,
          message_id_header: message.messageIdHeader,
          raw_rfc822: Buffer.from(rawRfc822),
          raw_sha256: hashRawMessage(rawRfc822),
          source_folder: mailbox.sourceFolder,
          status: "fetched",
        })
        .onConflict((oc) => oc.columns(["mailbox_id", "jmap_email_id"]).doNothing())
        .executeTakeFirst();

      const inserted = Number(insertResult.numInsertedOrUpdatedRows ?? 0);
      stagedReceipts += inserted;
    }

    return stagedReceipts;
  }

  async #upsertSyncState(
    mailbox: ResolvedTrackedMailbox,
    values: {
      emailQueryState: string | null;
      lastPushEventId: string | null;
      lastReconciledAt: Date | null;
      lastSuccessfulSyncAt: Date | null;
    },
  ): Promise<void> {
    const updatedAt = this.now();
    await this.db
      .insertInto("mailbox_sync_state")
      .values({
        email_query_state: values.emailQueryState,
        last_push_event_id: values.lastPushEventId,
        last_reconciled_at: values.lastReconciledAt,
        last_successful_sync_at: values.lastSuccessfulSyncAt,
        list_id: mailbox.listId,
        mailbox_id: mailbox.mailboxId,
        source_folder: mailbox.sourceFolder,
        updated_at: updatedAt,
      })
      .onConflict((oc) =>
        oc.column("source_folder").doUpdateSet({
          email_query_state: values.emailQueryState,
          last_push_event_id: values.lastPushEventId,
          last_reconciled_at: values.lastReconciledAt ?? sql`mailbox_sync_state.last_reconciled_at`,
          last_successful_sync_at: values.lastSuccessfulSyncAt,
          list_id: mailbox.listId,
          mailbox_id: mailbox.mailboxId,
          updated_at: updatedAt,
        }),
      )
      .execute();
  }

  async #processReceipt(receipt: MailboxReceiptRow): Promise<void> {
    const updatedAt = this.now();
    await this.db
      .updateTable("mailbox_receipts")
      .set({
        attempt_count: sql<number>`attempt_count + 1`,
        updated_at: updatedAt,
      })
      .where("id", "=", receipt.id)
      .execute();

    let parsed: ParsedMessageRecord;
    try {
      parsed = await this.parseMessage({
        archiveMonth: null,
        listId: receipt.list_id,
        pythonBin: this.runtime.parserBin,
        rawRfc822: receipt.raw_rfc822,
      });
    } catch (error) {
      await this.#markReceiptFailure(receipt.id, "parse_failed", error, null);
      return;
    }

    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("mailbox_receipts")
          .set({
            last_error: null,
            parsed_message_id: parsed.message_id,
            status: "parsed",
            updated_at: this.now(),
          })
          .where("id", "=", receipt.id)
          .execute();

        const existingMessage = await trx
          .selectFrom("messages")
          .select("id")
          .where("message_id", "=", parsed.message_id)
          .executeTakeFirst();
        if (existingMessage) {
          await trx
            .updateTable("mailbox_receipts")
            .set({
              last_error: null,
              parsed_message_id: parsed.message_id,
              status: "duplicate",
              stored_message_db_id: existingMessage.id,
              updated_at: this.now(),
            })
            .where("id", "=", receipt.id)
            .execute();
          return;
        }

        const parent = await fetchExistingThreadByMessageId(trx, parsed.in_reply_to);
        const reference = parent ?? (await fetchExistingReferenceThread(trx, parsed.refs));
        const effectiveListId = reference?.list_id ?? receipt.list_id;
        const effectiveThreadId = reference?.thread_id ?? parsed.thread_id;

        const insertedMessage = await trx
          .insertInto("messages")
          .values({
            archive_month: parsed.archive_month,
            body: parsed.body,
            from_email: parsed.from_email,
            from_name: parsed.from_name,
            in_reply_to: parsed.in_reply_to,
            list_id: effectiveListId,
            message_id: parsed.message_id,
            refs: parsed.refs,
            sent_at: parsed.sent_at,
            sent_at_approx: parsed.sent_at_approx,
            subject: parsed.subject,
            thread_id: effectiveThreadId,
          })
          .onConflict((oc) => oc.column("message_id").doNothing())
          .returning("id")
          .executeTakeFirst();

        const storedMessage = insertedMessage
          ? { id: insertedMessage.id, status: "stored" as const }
          : {
              id: (
                await trx
                  .selectFrom("messages")
                  .select("id")
                  .where("message_id", "=", parsed.message_id)
                  .executeTakeFirstOrThrow()
              ).id,
              status: "duplicate" as const,
            };

        if (storedMessage.status === "stored") {
          await insertAttachmentsForMessage(trx, storedMessage.id, parsed._attachments);
          await refreshTouchedThreadAggregate(trx, effectiveThreadId);
          await autoTrackParticipationForInsertedMessage(trx, storedMessage.id);
        }

        await trx
          .updateTable("mailbox_receipts")
          .set({
            last_error: null,
            parsed_message_id: parsed.message_id,
            status: storedMessage.status,
            stored_message_db_id: storedMessage.id,
            updated_at: this.now(),
          })
          .where("id", "=", receipt.id)
          .execute();
      });
    } catch (error) {
      await this.#markReceiptFailure(receipt.id, "store_failed", error, parsed.message_id);
    }
  }

  async #markReceiptFailure(
    receiptId: string,
    status: "parse_failed" | "store_failed",
    error: unknown,
    parsedMessageId: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("mailbox_receipts")
      .set({
        last_error: error instanceof Error ? error.message : String(error),
        parsed_message_id: parsedMessageId,
        status,
        updated_at: this.now(),
      })
      .where("id", "=", receiptId)
      .execute();
  }
}

export function createMailboxIngestService(
  dependencies: MailboxIngestServiceDependencies,
): MailboxIngestService {
  return new MailboxIngestService(dependencies);
}
