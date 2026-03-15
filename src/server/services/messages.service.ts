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
