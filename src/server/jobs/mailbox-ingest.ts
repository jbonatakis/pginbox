import { resolveMailboxIngestRuntimeConfig } from "../config";
import { db } from "../db";
import { createMailboxIngestService } from "../services/ingestion/mailbox-ingest.service";

const JOB_NAME = "mailbox:ingest";

interface ParsedArgs {
  help: boolean;
  once: boolean;
}

class CliUsageError extends Error {}

function usageText(): string {
  return `
Usage:
  bun src/server/jobs/mailbox-ingest.ts [options]

Options:
  --once     Run one sync + staged-receipt processing pass and exit
  --help     Show this help

Environment:
  FASTMAIL_API_TOKEN                 Required Fastmail API token
  FASTMAIL_JMAP_SESSION_URL          Optional JMAP session URL override
  MAILBOX_INGEST_PARSER_BIN          Python binary for parse_message_cli.py (default: python3)
  MAILBOX_INGEST_PUSH_PING_SECONDS   SSE ping interval in seconds
  MAILBOX_INGEST_QUERY_PAGE_SIZE     JMAP query page size
  MAILBOX_INGEST_RECEIPT_BATCH_SIZE  Receipt-processing batch size per sync pass
  MAILBOX_INGEST_SYNC_DEBOUNCE_MS    Push-event coalescing debounce
`.trim();
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    once: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    throw new CliUsageError(`Unknown option "${arg}"`);
  }

  return parsed;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.info(usageText());
    return;
  }

  const runtime = resolveMailboxIngestRuntimeConfig();
  const service = createMailboxIngestService({ runtime });

  console.info(
    [
      `[${JOB_NAME}]`,
      "starting",
      `mode=${args.once ? "once" : "worker"}`,
      `query_page_size=${runtime.queryPageSize}`,
      `receipt_batch_size=${runtime.receiptBatchSize}`,
      `push_ping_seconds=${runtime.pushPingSeconds}`,
      `sync_debounce_ms=${runtime.syncDebounceMs}`,
    ].join(" "),
  );

  if (args.once) {
    const result = await service.syncTrackedMailboxesOnce();
    console.info(
      [
        `[${JOB_NAME}]`,
        "completed",
        `changed_folders=${result.changedFolders}`,
        `staged_receipts=${result.stagedReceipts}`,
        `processed_receipts=${result.processedReceipts}`,
      ].join(" "),
    );
    return;
  }

  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await service.runWorker(abortController.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${JOB_NAME}] failed ${message}`);
  if (!(error instanceof CliUsageError) && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  if (error instanceof CliUsageError) {
    console.info(usageText());
  }
  process.exitCode = 1;
} finally {
  await db.destroy();
}
