import { Elysia, t } from "elysia";
import { toMessageWithAttachments } from "../serialize";
import { getMessage } from "../services/messages.service";

function parseMessageId(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

export const messagesRoutes = new Elysia({ prefix: "/messages" }).get(
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
