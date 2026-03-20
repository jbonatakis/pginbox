import { randomInt, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { db } from "../db";

const DEFAULT_COUNT = 1;
const DEFAULT_FROM_EMAIL = "dev-utility@example.com";
const DEFAULT_FROM_NAME = "Dev Utility";
const DEFAULT_SPACING_SECONDS = 60;

type CommandName = "add" | "create";
const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_DEV_THREAD_PREFIX = "dev-thread-";
const THREAD_STABLE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ParentMessageContext {
  messageId: string;
  refs: string[] | null;
}

interface BaseCommandOptions {
  body: string | null;
  count: number;
  fromEmail: string;
  fromName: string;
  json: boolean;
  sentAt: Date | null;
  spacingSeconds: number;
  useThreading: boolean;
}

export interface CreateCommandOptions extends BaseCommandOptions {
  command: "create";
  createList: boolean;
  list: string;
  subject: string | null;
  threadId: string | null;
}

export interface AddCommandOptions extends BaseCommandOptions {
  command: "add";
  replyTo: string | null;
  subject: string | null;
  threadId: string;
}

export interface ListCommandOptions {
  command: "list";
  json: boolean;
  limit: number;
  list: string | null;
  prefix: string | null;
}

export type ParsedCommand = AddCommandOptions | CreateCommandOptions | ListCommandOptions;

export interface MessagePlan {
  body: string | null;
  from_email: string;
  from_name: string;
  in_reply_to: string | null;
  list_id: number;
  message_id: string;
  refs: string[] | null;
  sent_at: Date | null;
  subject: string | null;
  thread_id: string;
}

interface ThreadContext {
  latestMessage: {
    id: string;
    messageId: string;
    refs: string[] | null;
    sentAt: Date | null;
  } | null;
  listId: number;
  listName: string | null;
  subject: string | null;
  threadId: string;
}

interface InsertedMessageSummary {
  body: string | null;
  id: string;
  inReplyTo: string | null;
  messageId: string;
  refs: string[] | null;
  sentAt: string | null;
}

interface CommandResult {
  insertedMessages: InsertedMessageSummary[];
  listId: number;
  listName: string | null;
  routePath: string;
  subject: string | null;
  threadId: string;
}

interface ListedThreadSummary {
  lastActivityAt: string | null;
  listId: number;
  listName: string;
  messageCount: number;
  routePath: string;
  subject: string | null;
  threadId: string;
}

interface ListCommandResult {
  items: ListedThreadSummary[];
  limit: number;
  listName: string | null;
  prefix: string | null;
}

class UsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "UsageError";
    this.exitCode = exitCode;
  }
}

function createThreadStableId(): string {
  return Array.from(
    { length: 10 },
    () => THREAD_STABLE_ID_ALPHABET[randomInt(THREAD_STABLE_ID_ALPHABET.length)]
  ).join("");
}

function compactTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z");
}

function createSyntheticId(prefix: string): string {
  return `${prefix}-${compactTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalDate(flag: string, value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") {
    return null;
  }
  if (trimmed.toLowerCase() === "now") {
    return new Date();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`${flag} must be an ISO-8601 timestamp or "now"`);
  }
  return parsed;
}

function requireNonEmpty(flag: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new UsageError(`${flag} cannot be empty`);
  }
  return trimmed;
}

function usageText(): string {
  return `Create or extend dev/test threads in the local database.

Usage:
  bun run dev:threads create --list <list-id-or-name> [options]
  bun run dev:threads add --thread <thread-id> [options]
  bun run dev:threads list [options]

Commands:
  create   Create a new thread and insert one or more generated messages.
  add      Insert one or more generated messages into an existing thread.
  list     Show matching dev threads with subjects and message counts.

Common options:
  --count <n>             Number of messages to insert (default: 1)
  --from-name <name>      Sender name (default: ${DEFAULT_FROM_NAME})
  --from-email <email>    Sender email (default: ${DEFAULT_FROM_EMAIL})
  --body <text>           Body text to reuse for every generated message
  --sent-at <iso|now>     Timestamp for the first inserted message (default: now)
  --spacing-seconds <n>   Gap between generated messages (default: ${DEFAULT_SPACING_SECONDS})
  --no-threading          Do not populate in_reply_to / refs
  --json                  Print machine-readable JSON output
  --help                  Show this help

Create options:
  --list <value>          Existing list id or list name
  --create-list           Create the list if a matching name does not exist
  --subject <text>        Thread subject (default: generated)
  --thread-id <text>      Explicit thread_id (default: generated)

Add options:
  --thread <thread-id>    Existing thread id to append to
  --subject <text>        Subject for newly inserted messages (default: existing thread subject)
  --reply-to <message-id> External message_id to reply to (default: latest message in the thread)

List options:
  --limit <n>             Maximum number of threads to show (default: ${DEFAULT_LIST_LIMIT})
  --prefix <text>         Only show thread_ids that start with this prefix (default: ${DEFAULT_DEV_THREAD_PREFIX})
  --all                   Disable prefix filtering and show any thread
  --list <value>          Restrict results to a single list id or list name

Examples:
  bun run dev:threads create --list pgsql-hackers --subject "Test follow-up" --count 3
  bun run dev:threads create --list dev-list --create-list --body "Synthetic thread body"
  bun run dev:threads add --thread dev-thread-20260317-abc123 --count 2
  bun run dev:threads add --thread dev-thread-20260317-abc123 --reply-to dev-msg-123 --body "Manual follow-up"
  bun run dev:threads list
  bun run dev:threads list --all --limit 50
`;
}

export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new UsageError(usageText(), 0);
  }

  if (argv.length === 0) {
    throw new UsageError(usageText());
  }

  const [commandName, ...rest] = argv;
  if (commandName !== "create" && commandName !== "add" && commandName !== "list") {
    throw new UsageError(`Unknown command "${commandName}".\n\n${usageText()}`);
  }

  const allowedFlags = new Set(["--json"]);
  if (commandName === "create") {
    allowedFlags.add("--create-list");
    allowedFlags.add("--no-threading");
  } else if (commandName === "add") {
    allowedFlags.add("--no-threading");
  } else {
    allowedFlags.add("--all");
  }
  const allowedValueOptions = new Set(
    commandName === "create"
      ? [
          "--body",
          "--count",
          "--from-email",
          "--from-name",
          "--list",
          "--sent-at",
          "--spacing-seconds",
          "--subject",
          "--thread-id",
        ]
      : [
          "--body",
          "--count",
          "--from-email",
          "--from-name",
          "--reply-to",
          "--sent-at",
          "--spacing-seconds",
          "--subject",
          "--thread",
        ],
  );
  if (commandName === "list") {
    allowedValueOptions.add("--limit");
    allowedValueOptions.add("--list");
    allowedValueOptions.add("--prefix");
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument "${token}"`);
    }

    if (allowedFlags.has(token)) {
      flags.add(token);
      continue;
    }

    if (!allowedValueOptions.has(token)) {
      throw new UsageError(`Unknown option "${token}"`);
    }

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }

  if (commandName === "list") {
    if (flags.has("--all") && values.has("--prefix")) {
      throw new UsageError("Use either --all or --prefix, not both");
    }

    return {
      command: "list",
      json: flags.has("--json"),
      limit: values.has("--limit")
        ? parsePositiveInteger("--limit", values.get("--limit") ?? "")
        : DEFAULT_LIST_LIMIT,
      list: values.has("--list") ? requireNonEmpty("--list", values.get("--list") ?? "") : null,
      prefix: flags.has("--all")
        ? null
        : values.has("--prefix")
          ? requireNonEmpty("--prefix", values.get("--prefix") ?? "")
          : DEFAULT_DEV_THREAD_PREFIX,
    };
  }

  const baseOptions: BaseCommandOptions = {
    body: values.has("--body") ? values.get("--body") ?? null : null,
    count: values.has("--count")
      ? parsePositiveInteger("--count", values.get("--count") ?? "")
      : DEFAULT_COUNT,
    fromEmail: requireNonEmpty("--from-email", values.get("--from-email") ?? DEFAULT_FROM_EMAIL),
    fromName: requireNonEmpty("--from-name", values.get("--from-name") ?? DEFAULT_FROM_NAME),
    json: flags.has("--json"),
    sentAt: values.has("--sent-at")
      ? parseOptionalDate("--sent-at", values.get("--sent-at") ?? "")
      : null,
    spacingSeconds: values.has("--spacing-seconds")
      ? parsePositiveInteger("--spacing-seconds", values.get("--spacing-seconds") ?? "")
      : DEFAULT_SPACING_SECONDS,
    useThreading: !flags.has("--no-threading"),
  };

  if (commandName === "create") {
    const list = requireNonEmpty("--list", values.get("--list") ?? "");
    return {
      ...baseOptions,
      command: "create",
      createList: flags.has("--create-list"),
      list,
      subject: values.has("--subject") ? requireNonEmpty("--subject", values.get("--subject") ?? "") : null,
      threadId: values.has("--thread-id")
        ? requireNonEmpty("--thread-id", values.get("--thread-id") ?? "")
        : null,
    };
  }

  return {
    ...baseOptions,
    command: "add",
    replyTo: values.has("--reply-to")
      ? requireNonEmpty("--reply-to", values.get("--reply-to") ?? "")
      : null,
    subject: values.has("--subject") ? requireNonEmpty("--subject", values.get("--subject") ?? "") : null,
    threadId: requireNonEmpty("--thread", values.get("--thread") ?? ""),
  };
}

function buildReplyRefs(parent: ParentMessageContext | null): string[] | null {
  if (!parent) return null;

  const refs = [...(parent.refs ?? [])];
  if (refs[refs.length - 1] !== parent.messageId) {
    refs.push(parent.messageId);
  }
  return refs;
}

function buildMessageBody(
  baseBody: string | null,
  threadId: string,
  index: number,
  count: number,
  mode: CommandName,
): string | null {
  if (baseBody !== null) return baseBody;

  const ordinal = index + 1;
  const summary = mode === "create" ? "Created by dev thread utility" : "Appended by dev thread utility";
  return `${summary}

thread_id: ${threadId}
message: ${ordinal} of ${count}
generated_at: ${new Date().toISOString()}`;
}

export function defaultFirstSentAt(
  latestSentAt: Date | null,
  spacingSeconds: number,
  now: Date = new Date(),
): Date {
  if (latestSentAt === null) {
    return now;
  }

  const candidate = new Date(latestSentAt.getTime() + spacingSeconds * 1000);
  return candidate.getTime() > now.getTime() ? candidate : now;
}

export function buildMessagePlans(input: {
  count: number;
  firstSentAt: Date | null;
  fromEmail: string;
  fromName: string;
  mode: CommandName;
  parent: ParentMessageContext | null;
  subject: string | null;
  threadId: string;
  listId: number;
  body: string | null;
  spacingSeconds: number;
  useThreading: boolean;
}): MessagePlan[] {
  const plans: MessagePlan[] = [];
  let parent = input.useThreading ? input.parent : null;

  for (let index = 0; index < input.count; index += 1) {
    const sentAt =
      input.firstSentAt === null
        ? null
        : new Date(input.firstSentAt.getTime() + index * input.spacingSeconds * 1000);
    const messageId = createSyntheticId("dev-msg");
    const plan: MessagePlan = {
      body: buildMessageBody(input.body, input.threadId, index, input.count, input.mode),
      from_email: input.fromEmail,
      from_name: input.fromName,
      in_reply_to: parent?.messageId ?? null,
      list_id: input.listId,
      message_id: messageId,
      refs: buildReplyRefs(parent),
      sent_at: sentAt,
      subject: input.subject,
      thread_id: input.threadId,
    };

    plans.push(plan);
    parent = input.useThreading ? { messageId, refs: plan.refs } : null;
  }

  return plans;
}

async function resolveList(listSelector: string, createIfMissing: boolean): Promise<{ id: number; name: string }> {
  const numericId = /^\d+$/.test(listSelector) ? Number.parseInt(listSelector, 10) : null;
  if (numericId !== null) {
    const byId = await db
      .selectFrom("lists")
      .select(["id", "name"])
      .where("id", "=", numericId)
      .executeTakeFirst();
    if (byId) return byId;
  }

  const byName = await db
    .selectFrom("lists")
    .select(["id", "name"])
    .where("name", "=", listSelector)
    .executeTakeFirst();
  if (byName) return byName;

  if (!createIfMissing) {
    const knownLists = await db
      .selectFrom("lists")
      .select(["id", "name"])
      .orderBy("name", "asc")
      .limit(10)
      .execute();
    const hint =
      knownLists.length === 0
        ? "No lists exist yet."
        : `Known lists: ${knownLists.map((row) => `${row.name} (#${row.id})`).join(", ")}`;
    throw new UsageError(`List "${listSelector}" does not exist. ${hint}`);
  }

  const inserted = await db
    .insertInto("lists")
    .values({ name: listSelector })
    .onConflict((oc) => oc.column("name").doNothing())
    .returning(["id", "name"])
    .executeTakeFirst();

  if (inserted) return inserted;

  const created = await db
    .selectFrom("lists")
    .select(["id", "name"])
    .where("name", "=", listSelector)
    .executeTakeFirst();
  if (!created) {
    throw new Error(`Failed to create or reload list "${listSelector}"`);
  }
  return created;
}

async function loadThreadContext(threadId: string): Promise<ThreadContext> {
  const [threadRow, latestMessageRow, firstMessageRow] = await Promise.all([
    db.selectFrom("threads").select(["thread_id", "list_id", "subject"]).where("thread_id", "=", threadId).executeTakeFirst(),
    db
      .selectFrom("messages")
      .select(["id", "message_id", "refs", "sent_at"])
      .where("thread_id", "=", threadId)
      .orderBy(sql`sent_at DESC NULLS FIRST`)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom("messages")
      .select(["list_id", "subject"])
      .where("thread_id", "=", threadId)
      .limit(1)
      .executeTakeFirst(),
  ]);

  const listId = threadRow?.list_id ?? firstMessageRow?.list_id;
  if (listId === undefined) {
    throw new UsageError(`Thread "${threadId}" does not exist`);
  }

  const listRow = await db
    .selectFrom("lists")
    .select(["id", "name"])
    .where("id", "=", listId)
    .executeTakeFirst();

  return {
    latestMessage: latestMessageRow
      ? {
          id: String(latestMessageRow.id),
          messageId: latestMessageRow.message_id,
          refs: latestMessageRow.refs,
          sentAt: latestMessageRow.sent_at,
        }
      : null,
    listId,
    listName: listRow?.name ?? null,
    subject: threadRow?.subject ?? firstMessageRow?.subject ?? null,
    threadId,
  };
}

async function loadReplyTarget(
  threadId: string,
  replyTo: string | null,
  fallback: ParentMessageContext | null,
): Promise<ParentMessageContext | null> {
  if (replyTo === null) {
    return fallback;
  }

  const row = await db
    .selectFrom("messages")
    .select(["message_id", "refs"])
    .where("thread_id", "=", threadId)
    .where("message_id", "=", replyTo)
    .executeTakeFirst();
  if (!row) {
    throw new UsageError(`Message "${replyTo}" was not found in thread "${threadId}"`);
  }

  return {
    messageId: row.message_id,
    refs: row.refs,
  };
}

async function refreshThreadAggregate(threadId: string, listId: number): Promise<void> {
  await sql`
    INSERT INTO threads (thread_id, id, list_id, subject, started_at, last_activity_at, message_count)
    SELECT
      thread_id,
      ${createThreadStableId()},
      list_id,
      _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST, id ASC))[1]),
      min(sent_at),
      max(sent_at),
      count(*)
    FROM messages
    WHERE list_id = ${listId}
      AND thread_id = ${threadId}
    GROUP BY thread_id, list_id
    ON CONFLICT (thread_id) DO UPDATE SET
      list_id = EXCLUDED.list_id,
      subject = EXCLUDED.subject,
      started_at = EXCLUDED.started_at,
      last_activity_at = EXCLUDED.last_activity_at,
      message_count = EXCLUDED.message_count
  `.execute(db);
}

async function insertMessages(plans: MessagePlan[]): Promise<InsertedMessageSummary[]> {
  const insertedRows = await db
    .insertInto("messages")
    .values(plans)
    .returning(["id", "message_id", "sent_at", "in_reply_to", "refs", "body"])
    .execute();

  const rowByMessageId = new Map(insertedRows.map((row) => [row.message_id, row]));
  return plans.map((plan) => {
    const row = rowByMessageId.get(plan.message_id);
    if (!row) {
      throw new Error(`Inserted message "${plan.message_id}" could not be reloaded`);
    }

    return {
      body: row.body,
      id: String(row.id),
      inReplyTo: row.in_reply_to,
      messageId: row.message_id,
      refs: row.refs,
      sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    };
  });
}

async function runCreate(command: CreateCommandOptions): Promise<CommandResult> {
  const list = await resolveList(command.list, command.createList);
  const threadId = command.threadId ?? createSyntheticId("dev-thread");
  const subject = command.subject ?? `Test thread ${threadId}`;
  const firstSentAt = command.sentAt ?? new Date();
  const plans = buildMessagePlans({
    body: command.body,
    count: command.count,
    firstSentAt,
    fromEmail: command.fromEmail,
    fromName: command.fromName,
    listId: list.id,
    mode: "create",
    parent: null,
    spacingSeconds: command.spacingSeconds,
    subject,
    threadId,
    useThreading: command.useThreading,
  });

  const insertedMessages = await insertMessages(plans);
  await refreshThreadAggregate(threadId, list.id);

  return {
    insertedMessages,
    listId: list.id,
    listName: list.name,
    routePath: `/threads/${encodeURIComponent(threadId)}`,
    subject,
    threadId,
  };
}

async function runAdd(command: AddCommandOptions): Promise<CommandResult> {
  const thread = await loadThreadContext(command.threadId);
  const subject = command.subject ?? thread.subject ?? `Re: ${thread.threadId}`;
  const parent = await loadReplyTarget(
    thread.threadId,
    command.replyTo,
    thread.latestMessage
      ? {
          messageId: thread.latestMessage.messageId,
          refs: thread.latestMessage.refs,
        }
      : null,
  );
  const firstSentAt =
    command.sentAt ?? defaultFirstSentAt(thread.latestMessage?.sentAt ?? null, command.spacingSeconds);
  const plans = buildMessagePlans({
    body: command.body,
    count: command.count,
    firstSentAt,
    fromEmail: command.fromEmail,
    fromName: command.fromName,
    listId: thread.listId,
    mode: "add",
    parent,
    spacingSeconds: command.spacingSeconds,
    subject,
    threadId: thread.threadId,
    useThreading: command.useThreading,
  });

  const insertedMessages = await insertMessages(plans);
  await refreshThreadAggregate(thread.threadId, thread.listId);

  return {
    insertedMessages,
    listId: thread.listId,
    listName: thread.listName,
    routePath: `/threads/${encodeURIComponent(thread.threadId)}`,
    subject,
    threadId: thread.threadId,
  };
}

async function runList(command: ListCommandOptions): Promise<ListCommandResult> {
  const resolvedList = command.list === null ? null : await resolveList(command.list, false);

  let query = db
    .selectFrom("threads")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .select([
      "threads.thread_id",
      "threads.subject",
      "threads.message_count",
      "threads.last_activity_at",
      "threads.list_id",
      "lists.name as list_name",
    ])
    .orderBy(sql`threads.last_activity_at DESC NULLS LAST`)
    .orderBy("threads.thread_id", "asc")
    .limit(command.limit);

  if (command.prefix !== null) {
    query = query.where("threads.thread_id", "like", `${command.prefix}%`);
  }

  if (resolvedList) {
    query = query.where("threads.list_id", "=", resolvedList.id);
  }

  const rows = await query.execute();
  return {
    items: rows.map((row) => ({
      lastActivityAt: row.last_activity_at ? row.last_activity_at.toISOString() : null,
      listId: row.list_id,
      listName: row.list_name,
      messageCount: row.message_count,
      routePath: `/threads/${encodeURIComponent(row.thread_id)}`,
      subject: row.subject,
      threadId: row.thread_id,
    })),
    limit: command.limit,
    listName: resolvedList?.name ?? null,
    prefix: command.prefix,
  };
}

function printHumanMutationResult(command: CreateCommandOptions | AddCommandOptions, result: CommandResult): void {
  const verb = command.command === "create" ? "Created" : "Updated";
  console.log(`${verb} thread ${result.threadId}`);
  console.log(`List: ${result.listName ?? "(unknown)"} (#${result.listId})`);
  console.log(`Subject: ${result.subject ?? "(none)"}`);
  console.log(`Route: ${result.routePath}`);
  console.log("Inserted messages:");
  for (const [index, message] of result.insertedMessages.entries()) {
    console.log(
      `  ${index + 1}. db_id=${message.id} message_id=${message.messageId} sent_at=${message.sentAt ?? "null"}`
    );
  }
}

function printHumanListResult(result: ListCommandResult): void {
  console.log(
    `Matched ${result.items.length} thread${result.items.length === 1 ? "" : "s"}`
      + ` (limit ${result.limit}, prefix ${result.prefix ?? "(all)"})`
      + (result.listName ? ` in list ${result.listName}` : ""),
  );
  for (const [index, item] of result.items.entries()) {
    console.log(
      `  ${index + 1}. ${item.threadId} count=${item.messageCount} list=${item.listName} subject=${item.subject ?? "(none)"}`
    );
  }
}

function printJsonMutationResult(command: CreateCommandOptions | AddCommandOptions, result: CommandResult): void {
  console.log(
    JSON.stringify(
      {
        command: command.command,
        insertedCount: result.insertedMessages.length,
        ...result,
      },
      null,
      2,
    ),
  );
}

function printJsonListResult(result: ListCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

export async function runCli(argv: string[]): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.exitCode === 0) {
        console.log(error.message);
      } else {
        console.error(error.message);
      }
      return error.exitCode;
    }
    throw error;
  }

  try {
    if (parsed.command === "list") {
      const result = await runList(parsed);
      if (parsed.json) {
        printJsonListResult(result);
      } else {
        printHumanListResult(result);
      }
    } else {
      const result = parsed.command === "create" ? await runCreate(parsed) : await runAdd(parsed);
      if (parsed.json) {
        printJsonMutationResult(parsed, result);
      } else {
        printHumanMutationResult(parsed, result);
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
