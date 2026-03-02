import { db } from "../db";

export async function getMessage(id: bigint) {
  const message = await db
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!message) return null;

  const attachments = await db
    .selectFrom("attachments")
    .select(["id", "filename", "content_type", "size_bytes"])
    .where("message_id", "=", id)
    .execute();

  return { ...message, attachments };
}
