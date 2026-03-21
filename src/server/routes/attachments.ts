import { Elysia, t } from "elysia";
import { requireAuth, resolveCurrentSession, type ResponseCookieTarget } from "../auth";
import { toAttachmentDetail } from "../serialize";
import { getAttachment } from "../services/attachments.service";

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

function parseAttachmentId(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

function downloadFilename(id: bigint, filename: string | null): string {
  const trimmed = filename?.trim() ?? "";
  if (trimmed.length > 0) return trimmed;
  return `attachment-${id}.txt`;
}

function downloadContentType(contentType: string | null): string {
  const normalized = contentType?.trim() ?? "";
  if (normalized.length > 0) return normalized;
  return "text/plain; charset=utf-8";
}

export const attachmentsRoutes = new Elysia({ prefix: "/attachments" })
  .get(
    "/:id",
    async ({ params, status }) => {
      const id = parseAttachmentId(params.id);
      if (id === null) return status(400, { message: "Invalid attachment id" });
      const raw = await getAttachment(id);
      if (!raw) return status(404, { message: "Attachment not found" });
      return toAttachmentDetail(raw);
    },
    { params: t.Object({ id: t.String() }) }
  )
  .get(
    "/:id/download",
    async ({ params, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAuth(resolved);
      const id = parseAttachmentId(params.id);
      if (id === null) return status(400, { message: "Invalid attachment id" });
      const raw = await getAttachment(id);
      if (!raw) return status(404, { message: "Attachment not found" });
      if (!raw.has_content || raw.content === null) {
        return status(409, { message: "Attachment download not available" });
      }

      set.headers["content-disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(downloadFilename(id, raw.filename))}`;
      set.headers["content-type"] = downloadContentType(raw.content_type);
      return raw.content;
    },
    { params: t.Object({ id: t.String() }) }
  );
