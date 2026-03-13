import { db } from "../db";
import { getAttachmentsForMessage } from "./attachments.service";

export async function getMessage(id: bigint) {
  const message = await db
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!message) return null;

  const attachments = await getAttachmentsForMessage(id);

  return { ...message, attachments };
}
