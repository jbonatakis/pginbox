import { Elysia, t } from "elysia";
import { getMessage } from "../services/messages.service";

export const messagesRoutes = new Elysia({ prefix: "/messages" }).get(
  "/:id",
  async ({ params, error }) => {
    const message = await getMessage(BigInt(params.id));
    return message ?? error(404, { message: "Message not found" });
  },
  { params: t.Object({ id: t.String() }) }
);
