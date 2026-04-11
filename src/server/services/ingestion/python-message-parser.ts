import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PARSE_MESSAGE_CLI_PATH = fileURLToPath(
  new URL("../../../ingestion/parse_message_cli.py", import.meta.url),
);

export interface ParsedMessageAttachment {
  content: string | null;
  content_type: string;
  filename: string | null;
  size_bytes: number | null;
}

export interface ParsedMessageRecord {
  _attachments: ParsedMessageAttachment[];
  _normalized_subject: string;
  archive_month: string | null;
  body: string;
  from_email: string;
  from_name: string;
  in_reply_to: string | null;
  list_id: number;
  message_id: string;
  refs: string[] | null;
  sent_at: string | null;
  sent_at_approx: boolean;
  subject: string;
  thread_id: string;
  warnings: string[];
}

export interface PythonMessageParserOptions {
  archiveMonth?: string | null;
  cliPath?: string;
  listId: number;
  pythonBin: string;
  rawRfc822: Uint8Array;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Python parser field "${field}" must be a string`);
  }

  return value;
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value == null) {
    return null;
  }

  return expectString(value, field);
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Python parser field "${field}" must be a finite number`);
  }

  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Python parser field "${field}" must be a boolean`);
  }

  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Python parser field "${field}" must be an array of strings`);
  }

  return value;
}

function normalizeAttachment(value: unknown): ParsedMessageAttachment {
  if (!value || typeof value !== "object") {
    throw new Error("Python parser attachment must be an object");
  }

  const attachment = value as Record<string, unknown>;
  return {
    content: expectNullableString(attachment.content, "_attachments[].content"),
    content_type: expectString(attachment.content_type, "_attachments[].content_type"),
    filename: expectNullableString(attachment.filename, "_attachments[].filename"),
    size_bytes:
      attachment.size_bytes == null
        ? null
        : expectNumber(attachment.size_bytes, "_attachments[].size_bytes"),
  };
}

function normalizeParsedMessageRecord(value: unknown): ParsedMessageRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Python parser output must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  const attachmentsRaw = record._attachments;
  const warningsRaw = record.warnings;

  return {
    _attachments: Array.isArray(attachmentsRaw) ? attachmentsRaw.map(normalizeAttachment) : [],
    _normalized_subject: expectString(record._normalized_subject, "_normalized_subject"),
    archive_month: expectNullableString(record.archive_month, "archive_month"),
    body: expectString(record.body, "body"),
    from_email: expectString(record.from_email, "from_email"),
    from_name: expectString(record.from_name, "from_name"),
    in_reply_to: expectNullableString(record.in_reply_to, "in_reply_to"),
    list_id: expectNumber(record.list_id, "list_id"),
    message_id: expectString(record.message_id, "message_id"),
    refs: record.refs == null ? null : expectStringArray(record.refs, "refs"),
    sent_at: expectNullableString(record.sent_at, "sent_at"),
    sent_at_approx: expectBoolean(record.sent_at_approx, "sent_at_approx"),
    subject: expectString(record.subject, "subject"),
    thread_id: expectString(record.thread_id, "thread_id"),
    warnings: warningsRaw == null ? [] : expectStringArray(warningsRaw, "warnings"),
  };
}

export async function parseMessageWithPython(
  options: PythonMessageParserOptions,
): Promise<ParsedMessageRecord> {
  const args = [options.cliPath ?? DEFAULT_PARSE_MESSAGE_CLI_PATH, "--list-id", String(options.listId)];
  if (options.archiveMonth) {
    args.push("--archive-month", options.archiveMonth.slice(0, 7));
  }

  const child = spawn(options.pythonBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  child.stdout.on("data", (chunk: Uint8Array) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderrChunks.push(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(Buffer.from(options.rawRfc822));
  });

  const stdoutText = Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  const stderrText = Buffer.concat(stderrChunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");

  if (exitCode !== 0) {
    throw new Error(
      `Python parser exited with code ${exitCode}${
        stderrText ? `: ${stderrText.trim()}` : ""
      }`,
    );
  }

  try {
    return normalizeParsedMessageRecord(JSON.parse(stdoutText) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Python parser returned invalid JSON: ${message}${
        stderrText ? ` (stderr: ${stderrText.trim()})` : ""
      }`,
    );
  }
}
