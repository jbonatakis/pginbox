import { sql } from "kysely";
import { toDbInt8, toDbInt8List, type DbInt8Value } from "../db-ids";
import { db } from "../db";

export interface AttachmentSummaryRow {
  id: bigint | number | string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  has_content: boolean;
}

export interface AttachmentDetailRow extends AttachmentSummaryRow {
  content: string | null;
}

interface AttachmentSummaryByMessageRow extends AttachmentSummaryRow {
  message_id: bigint | number | string;
}

function attachmentIdentityKey(row: Pick<AttachmentSummaryRow, "filename" | "content_type" | "size_bytes">) {
  return [
    row.filename ?? "<null>",
    row.content_type ?? "<null>",
    row.size_bytes ?? -1,
  ].join("\x1f");
}

export function dedupeAttachmentRows<T extends AttachmentSummaryRow>(rows: T[]): T[] {
  const deduped: T[] = [];
  const indexByKey = new Map<string, number>();

  for (const row of rows) {
    const key = attachmentIdentityKey(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      deduped.push(row);
      indexByKey.set(key, deduped.length - 1);
      continue;
    }

    const existing = deduped[existingIndex];
    if (!existing.has_content && row.has_content) {
      deduped[existingIndex] = row;
    }
  }

  return deduped;
}

export async function getAttachmentsForMessage(messageId: DbInt8Value) {
  const rows = await db
    .selectFrom("attachments")
    .select([
      "attachments.id",
      "attachments.filename",
      "attachments.content_type",
      "attachments.size_bytes",
      sql<boolean>`attachments.content is not null`.as("has_content"),
    ])
    .where("attachments.message_id", "=", toDbInt8(messageId))
    .orderBy("attachments.id", "asc")
    .execute();

  return dedupeAttachmentRows(rows);
}

export async function getAttachment(id: DbInt8Value) {
  const row = await db
    .selectFrom("attachments")
    .select([
      "attachments.id",
      "attachments.filename",
      "attachments.content_type",
      "attachments.size_bytes",
      sql<boolean>`attachments.content is not null`.as("has_content"),
      "attachments.content",
    ])
    .where("attachments.id", "=", toDbInt8(id))
    .executeTakeFirst();

  return row ?? null;
}

export async function getAttachmentsByMessageIds(messageIds: readonly DbInt8Value[]) {
  if (messageIds.length === 0) return new Map<string, AttachmentSummaryRow[]>();

  const rows = await db
    .selectFrom("attachments")
    .select([
      "attachments.message_id",
      "attachments.id",
      "attachments.filename",
      "attachments.content_type",
      "attachments.size_bytes",
      sql<boolean>`attachments.content is not null`.as("has_content"),
    ])
    .where("attachments.message_id", "in", toDbInt8List(messageIds))
    .orderBy("attachments.message_id", "asc")
    .orderBy("attachments.id", "asc")
    .execute();

  const grouped = new Map<string, AttachmentSummaryByMessageRow[]>();
  for (const row of rows) {
    const key = String(row.message_id);
    const current = grouped.get(key);
    if (current) {
      current.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const deduped = new Map<string, AttachmentSummaryRow[]>();
  for (const [messageId, attachments] of grouped.entries()) {
    deduped.set(messageId, dedupeAttachmentRows(attachments));
  }

  return deduped;
}
