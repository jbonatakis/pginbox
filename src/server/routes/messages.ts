import { Elysia, t } from "elysia";
import { DEFAULT_THREAD_MESSAGES_PAGE_SIZE } from "shared/api";
import { toMessagePermalink, toMessageWithAttachments } from "../serialize";
import { getMessage, getMessagePermalink } from "../services/messages.service";

function parseMessageId(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

export const messagesRoutes = new Elysia({ prefix: "/messages" }).get(
  "/:id/permalink",
  async ({ params, status }) => {
    const id = parseMessageId(params.id);
    if (id === null) return status(400, { message: "Invalid message id" });

    const raw = await getMessagePermalink(id, DEFAULT_THREAD_MESSAGES_PAGE_SIZE);
    if (!raw) return status(404, { message: "Message not found" });
    return toMessagePermalink(raw);
  },
  { params: t.Object({ id: t.String() }) }
).get(
  "/:id",
  async ({ params, status }) => {
    const id = parseMessageId(params.id);
    if (id === null) return status(400, { message: "Invalid message id" });
    const raw = await getMessage(id);
    if (!raw) return status(404, { message: "Message not found" });
    return toMessageWithAttachments(raw, raw.attachments);
  },
  { params: t.Object({ id: t.String() }) }
);
