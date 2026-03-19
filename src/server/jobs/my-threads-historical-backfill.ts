import { db } from "../db";
import { runHistoricalParticipationBackfill } from "../services/thread-progress.service";

const JOB_NAME = "my-threads:backfill";
const DEFAULT_BATCH_SIZE = 200;

interface ParsedArgs {
  batchSize: number;
  help: boolean;
  maxUsers: number | null;
  startAfterUserId: string | null;
}

class CliUsageError extends Error {}

function usageText(): string {
  return `
Usage:
  bun src/server/jobs/my-threads-historical-backfill.ts [options]

Options:
  --batch-size <n>           Users to scan per batch (default: ${DEFAULT_BATCH_SIZE})
  --max-users <n>            Stop after scanning n eligible users
  --start-after-user-id <id> Resume after a specific user id
  --help                     Show this help

Examples:
  bun src/server/jobs/my-threads-historical-backfill.ts
  bun src/server/jobs/my-threads-historical-backfill.ts --batch-size 250
  bun src/server/jobs/my-threads-historical-backfill.ts --batch-size 250 --start-after-user-id 10000
  bun src/server/jobs/my-threads-historical-backfill.ts --max-users 500
`.trim();
}

function parsePositiveInteger(name: string, rawValue: string): number {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliUsageError(`${name} must be a positive integer`);
  }
  return value;
}

function parseUserId(name: string, rawValue: string): string {
  try {
    const value = BigInt(rawValue);
    if (value < 0n) {
      throw new CliUsageError(`${name} must be zero or greater`);
    }
    return value.toString();
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error;
    }
    throw new CliUsageError(`${name} must be a valid integer user id`);
  }
}

function readOptionValue(argv: string[], index: number, flag: string): { nextIndex: number; value: string } {
  const current = argv[index]!;
  const [, inlineValue] = current.split("=", 2);
  if (inlineValue !== undefined) {
    return { nextIndex: index, value: inlineValue };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }

  return { nextIndex: index + 1, value: next };
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    batchSize: DEFAULT_BATCH_SIZE,
    help: false,
    maxUsers: null,
    startAfterUserId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      const { nextIndex, value } = readOptionValue(argv, index, "--batch-size");
      parsed.batchSize = parsePositiveInteger("--batch-size", value);
      index = nextIndex;
      continue;
    }

    if (arg === "--max-users" || arg.startsWith("--max-users=")) {
      const { nextIndex, value } = readOptionValue(argv, index, "--max-users");
      parsed.maxUsers = parsePositiveInteger("--max-users", value);
      index = nextIndex;
      continue;
    }

    if (arg === "--start-after-user-id" || arg.startsWith("--start-after-user-id=")) {
      const { nextIndex, value } = readOptionValue(argv, index, "--start-after-user-id");
      parsed.startAfterUserId = parseUserId("--start-after-user-id", value);
      index = nextIndex;
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

  console.info(
    [
      `[${JOB_NAME}]`,
      "starting",
      `batch_size=${args.batchSize}`,
      `max_users=${args.maxUsers ?? "all"}`,
      `start_after_user_id=${args.startAfterUserId ?? "none"}`,
    ].join(" ")
  );

  const result = await runHistoricalParticipationBackfill({
    batchSize: args.batchSize,
    maxUsers: args.maxUsers,
    onBatch: (batch) => {
      console.info(
        [
          `[${JOB_NAME}]`,
          `batch=${batch.batchNumber}`,
          `users_scanned=${batch.usersScanned}`,
          `users_with_matches=${batch.usersWithMatches}`,
          `matched_threads=${batch.matchedThreads}`,
          `progress_seeded=${batch.progressSeeded}`,
          `first_user_id=${batch.firstUserId}`,
          `last_user_id=${batch.lastUserId}`,
          `completed_at=${batch.completedAt.toISOString()}`,
        ].join(" ")
      );
    },
    startAfterUserId: args.startAfterUserId,
  });

  console.info(
    [
      `[${JOB_NAME}]`,
      "completed",
      `started_at=${result.startedAt.toISOString()}`,
      `completed_at=${result.completedAt.toISOString()}`,
      `batch_size=${result.batchSize}`,
      `batches=${result.batches}`,
      `users_scanned=${result.usersScanned}`,
      `users_with_matches=${result.usersWithMatches}`,
      `matched_threads=${result.matchedThreads}`,
      `progress_seeded=${result.progressSeeded}`,
      `last_user_id=${result.lastUserId ?? "none"}`,
    ].join(" ")
  );
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
