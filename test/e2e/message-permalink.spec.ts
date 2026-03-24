import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { DEFAULT_THREAD_MESSAGES_PAGE_SIZE } from "../../src/shared/api";
import { resolveDatabaseUrl } from "../../src/server/config";
import type { DB } from "../../src/server/types/db.d.ts";

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: resolveDatabaseUrl(),
  }),
});

const db = new Kysely<DB>({ dialect });

type PermalinkFixture = {
  listId: number;
  rawThreadId: string;
  stableThreadId: string;
  targetMessageId: string;
};

function uid(): string {
  return randomBytes(6).toString("hex");
}

function stableThreadId(token: string): string {
  return `E2E${token.slice(0, 7).toUpperCase()}`;
}

async function createPermalinkFixture(): Promise<PermalinkFixture> {
  const token = uid();
  const stableId = stableThreadId(token);
  const rawThreadId = `<e2e-message-permalink-${token}@example.com>`;
  const messageCount = DEFAULT_THREAD_MESSAGES_PAGE_SIZE + 3;

  const listRow = await db
    .insertInto("lists")
    .values({ name: `e2e-message-permalink-${token}` })
    .returning("id")
    .executeTakeFirstOrThrow();

  const startedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

  await db
    .insertInto("threads")
    .values({
      id: stableId,
      thread_id: rawThreadId,
      list_id: listRow.id,
      subject: "E2E message permalink fixture",
      started_at: startedAt,
      last_activity_at: new Date(Date.UTC(2024, 0, 1, 0, 0, messageCount - 1)),
      message_count: messageCount,
    })
    .execute();

  const insertedMessages = await db
    .insertInto("messages")
    .values(
      Array.from({ length: messageCount }, (_, index) => ({
        message_id: `e2e-message-permalink-${token}-${index}@example.com`,
        thread_id: rawThreadId,
        list_id: listRow.id,
        sent_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)),
        from_name: "Playwright E2E",
        from_email: "playwright-e2e@example.com",
        subject: `Fixture message ${index + 1}`,
        body: `Fixture body ${index + 1}`,
        in_reply_to: null,
        refs: null,
        sent_at_approx: false,
      }))
    )
    .returning("id")
    .execute();

  return {
    listId: listRow.id,
    rawThreadId,
    stableThreadId: stableId,
    targetMessageId: String(insertedMessages[0]!.id),
  };
}

async function cleanupPermalinkFixture(fixture: PermalinkFixture): Promise<void> {
  await db.deleteFrom("messages").where("thread_id", "=", fixture.rawThreadId).execute();
  await db.deleteFrom("threads").where("thread_id", "=", fixture.rawThreadId).execute();
  await db.deleteFrom("lists").where("id", "=", fixture.listId).execute();
}

test.afterAll(async () => {
  await db.destroy();
});

test("message permalink redirects into the containing thread page", async ({ page, baseURL }) => {
  const fixture = await createPermalinkFixture();

  try {
    const appBaseUrl = baseURL ?? "http://localhost:5173";
    const expectedUrl = new URL(
      `/t/${encodeURIComponent(fixture.stableThreadId)}?page=1#message-${fixture.targetMessageId}`,
      appBaseUrl
    ).toString();

    await page.goto(`/m/${encodeURIComponent(fixture.targetMessageId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(expectedUrl);

    await expect(page.locator("[data-route-heading]")).toHaveText("Thread Detail");
    await expect(page.locator(`#message-${fixture.targetMessageId}`)).toBeVisible();
  } finally {
    await cleanupPermalinkFixture(fixture);
  }
});
