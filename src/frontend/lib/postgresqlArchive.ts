const POSTGRESQL_MESSAGE_ARCHIVE_BASE_URL = "https://www.postgresql.org/message-id/";

function normalizeMessageId(messageId: string | null | undefined): string | null {
  const trimmed = messageId?.trim() ?? "";
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const unwrapped = trimmed.slice(1, -1).trim();
    return unwrapped.length > 0 ? unwrapped : null;
  }

  return trimmed;
}

export function postgresqlArchiveMessageUrl(messageId: string | null | undefined): string | null {
  const normalized = normalizeMessageId(messageId);
  if (normalized === null) return null;

  return `${POSTGRESQL_MESSAGE_ARCHIVE_BASE_URL}${encodeURIComponent(normalized)}`;
}
