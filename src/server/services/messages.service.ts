import { sql } from "kysely";
import { type DbInt8Value, toDbInt8 } from "../db-ids";
import { db } from "../db";
import { getAttachmentsForMessage } from "./attachments.service";

export async function getMessage(id: DbInt8Value) {
  const message = await db
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", toDbInt8(id))
    .executeTakeFirst();

  if (!message) return null;

  const attachments = await getAttachmentsForMessage(id);

  return { ...message, attachments };
}

export async function getMessagePermalink(id: DbInt8Value, pageSize: number) {
  const result = await sql<{
    message_id: string;
    page: string;
    thread_id: string;
  }>`
    WITH target AS (
      SELECT
        messages.id,
        messages.thread_id,
        threads.id AS stable_thread_id
      FROM messages
      JOIN threads
        ON threads.thread_id = messages.thread_id
      WHERE messages.id = ${toDbInt8(id)}
    ),
    ordered AS (
      SELECT
        messages.id,
        row_number() OVER (
          ORDER BY messages.sent_at ASC NULLS LAST, messages.id ASC
        ) AS ordinal
      FROM messages
      JOIN target
        ON target.thread_id = messages.thread_id
    )
    SELECT
      target.id::text AS message_id,
      target.stable_thread_id AS thread_id,
      GREATEST(1, CEIL(ordered.ordinal::numeric / ${pageSize}::numeric))::text AS page
    FROM target
    JOIN ordered
      ON ordered.id = target.id
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  return {
    messageId: row.message_id,
    page: Number(row.page),
    pageSize,
    threadId: row.thread_id,
  };
}
