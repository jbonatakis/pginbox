import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "../../src/server/db";
import { runHistoricalParticipationBackfill } from "../../src/server/services/thread-progress.service";

function uid(): string {
  return randomBytes(6).toString("hex");
}

function stableThreadId(): string {
  return uid().slice(0, 10).toUpperCase();
}

function previousUserId(userId: string): string {
  const value = BigInt(userId);
  return value > 0n ? (value - 1n).toString() : "0";
}

interface TestMessageSeed {
  fromEmail: string;
  key: string;
  sentAt: Date | null;
}

const createdListIds: number[] = [];
const createdMessageIds: string[] = [];
const createdThreadIds: string[] = [];
const createdUserIds: string[] = [];

async function createUser(
  overrides: Partial<{
    createdAt: Date;
    disabledAt: Date | null;
    email: string;
    emailVerifiedAt: Date | null;
    status: "active" | "disabled" | "pending_verification";
  }> = {}
): Promise<{ email: string; id: string }> {
  const createdAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const email = overrides.email ?? `my-threads-backfill-${uid()}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      created_at: overrides.createdAt ?? createdAt,
      disable_reason: overrides.disabledAt ? "test disable" : null,
      disabled_at: overrides.disabledAt ?? null,
      display_name: null,
      email,
      email_verified_at:
        overrides.emailVerifiedAt === undefined
          ? createdAt
          : overrides.emailVerifiedAt,
      last_login_at: null,
      password_hash: "placeholder-not-verified",
      status: overrides.status ?? "active",
      updated_at: overrides.createdAt ?? createdAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const id = String(row.id);
  createdUserIds.push(id);
  return { email, id };
}

async function createVerifiedUser(): Promise<{ email: string; id: string }> {
  return createUser();
}

async function createList(): Promise<number> {
  const row = await db
    .insertInto("lists")
    .values({ name: `my-threads-backfill-${uid()}` })
    .returning("id")
    .executeTakeFirstOrThrow();

  const listId = row.id as number;
  createdListIds.push(listId);
  return listId;
}

async function createThreadWithMessages(
  listId: number,
  messages: TestMessageSeed[]
): Promise<{ messageIds: Record<string, string>; threadId: string }> {
  const threadId = `my-threads-backfill-${uid()}`;
  createdThreadIds.push(threadId);

  await db
    .insertInto("threads")
    .values({
      id: stableThreadId(),
      last_activity_at: null,
      list_id: listId,
      started_at: null,
      subject: "Backfill test thread",
      thread_id: threadId,
    })
    .execute();

  const inserted = await db
    .insertInto("messages")
    .values(
      messages.map((message) => ({
        body: null,
        from_email: message.fromEmail,
        from_name: "Backfill Tester",
        in_reply_to: null,
        list_id: listId,
        message_id: `msg-${uid()}`,
        refs: null,
        sent_at: message.sentAt,
        subject: message.key,
        thread_id: threadId,
      }))
    )
    .returning(["id", "subject"])
    .execute();

  const messageIds = Object.fromEntries(inserted.map((row) => [row.subject ?? "", String(row.id)]));
  createdMessageIds.push(...inserted.map((row) => String(row.id)));

  return { messageIds, threadId };
}

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.deleteFrom("thread_tracking").where("user_id", "in", createdUserIds).execute();
    await db.deleteFrom("thread_read_progress").where("user_id", "in", createdUserIds).execute();
  }

  if (createdMessageIds.length > 0) {
    await db.deleteFrom("messages").where("id", "in", createdMessageIds).execute();
    createdMessageIds.length = 0;
  }

  if (createdThreadIds.length > 0) {
    await db.deleteFrom("threads").where("thread_id", "in", createdThreadIds).execute();
    createdThreadIds.length = 0;
  }

  if (createdUserIds.length > 0) {
    await db.deleteFrom("users").where("id", "in", createdUserIds).execute();
    createdUserIds.length = 0;
  }

  if (createdListIds.length > 0) {
    await db.deleteFrom("lists").where("id", "in", createdListIds).execute();
    createdListIds.length = 0;
  }
});

describe("historical My Threads backfill", () => {
  it("matches users by exact case-insensitive email without pulling in similar addresses", async () => {
    const token = uid();
    const exactUser = await createUser({
      email: `exact-${token}@example.com`,
    });
    const similarUser = await createUser({
      email: `exact-${token}-other@example.com`,
    });
    const listId = await createList();
    const thread = await createThreadWithMessages(listId, [
      { fromEmail: exactUser.email.toUpperCase(), key: "mine-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 1, 0)) },
      { fromEmail: "other@example.com", key: "other-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 2, 0)) },
    ]);
    const earliestUserId = [exactUser.id, similarUser.id].reduce((lowest, current) =>
      BigInt(current) < BigInt(lowest) ? current : lowest
    );

    const result = await runHistoricalParticipationBackfill({
      batchSize: 10,
      maxUsers: 10,
      startAfterUserId: previousUserId(earliestUserId),
    });

    expect(result.usersScanned).toBe(2);
    expect(result.usersWithMatches).toBe(1);
    expect(result.matchedThreads).toBe(1);

    const exactTracking = await db
      .selectFrom("thread_tracking")
      .select("anchor_message_id")
      .where("user_id", "=", exactUser.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    expect(String(exactTracking.anchor_message_id)).toBe(thread.messageIds["mine-1"]);

    const similarTracking = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", similarUser.id)
      .executeTakeFirst();
    expect(similarTracking).toBeUndefined();
  });

  it("only scans verified active users even when disabled or pending users have matching mail", async () => {
    const activeUser = await createUser({
      email: `eligible-${uid()}@example.com`,
    });
    const disabledUser = await createUser({
      email: `disabled-${uid()}@example.com`,
      status: "disabled",
      disabledAt: new Date(Date.UTC(2024, 0, 2, 0, 0, 0)),
    });
    const pendingUser = await createUser({
      email: `pending-${uid()}@example.com`,
      status: "pending_verification",
      emailVerifiedAt: null,
    });
    const listId = await createList();

    await createThreadWithMessages(listId, [
      { fromEmail: activeUser.email.toUpperCase(), key: "active-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 1, 0)) },
    ]);
    await createThreadWithMessages(listId, [
      { fromEmail: disabledUser.email.toUpperCase(), key: "disabled-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 2, 0)) },
    ]);
    await createThreadWithMessages(listId, [
      { fromEmail: pendingUser.email.toUpperCase(), key: "pending-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 3, 0)) },
    ]);

    const earliestUserId = [activeUser.id, disabledUser.id, pendingUser.id].reduce((lowest, current) =>
      BigInt(current) < BigInt(lowest) ? current : lowest
    );

    const result = await runHistoricalParticipationBackfill({
      batchSize: 10,
      maxUsers: 10,
      startAfterUserId: previousUserId(earliestUserId),
    });

    expect(result.usersScanned).toBe(1);
    expect(result.usersWithMatches).toBe(1);
    expect(result.matchedThreads).toBe(1);

    const activeTracking = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", activeUser.id)
      .executeTakeFirst();
    const disabledTracking = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", disabledUser.id)
      .executeTakeFirst();
    const pendingTracking = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", pendingUser.id)
      .executeTakeFirst();

    expect(activeTracking).toBeDefined();
    expect(disabledTracking).toBeUndefined();
    expect(pendingTracking).toBeUndefined();
  });

  it("uses the latest user-authored message as the anchor without disturbing manual follows", async () => {
    const user = await createVerifiedUser();
    const listId = await createList();
    const thread = await createThreadWithMessages(listId, [
      { fromEmail: "other@example.com", key: "other-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)) },
      { fromEmail: user.email, key: "mine-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 1, 0)) },
      { fromEmail: user.email, key: "mine-2", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 2, 0)) },
      { fromEmail: "other@example.com", key: "other-2", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 3, 0)) },
    ]);
    const manualFollowedAt = new Date(Date.UTC(2024, 1, 1, 12, 0, 0));

    await db
      .insertInto("thread_tracking")
      .values({
        anchor_message_id: thread.messageIds["mine-1"],
        created_at: manualFollowedAt,
        manual_followed_at: manualFollowedAt,
        participated_at: null,
        participation_suppressed_at: null,
        thread_id: thread.threadId,
        updated_at: manualFollowedAt,
        user_id: user.id,
      })
      .execute();

    const result = await runHistoricalParticipationBackfill({
      batchSize: 1,
      maxUsers: 1,
      startAfterUserId: previousUserId(user.id),
    });

    expect(result.usersScanned).toBe(1);
    expect(result.usersWithMatches).toBe(1);
    expect(result.matchedThreads).toBe(1);

    const trackingRow = await db
      .selectFrom("thread_tracking")
      .select(["anchor_message_id", "manual_followed_at", "participated_at"])
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(String(trackingRow.anchor_message_id)).toBe(thread.messageIds["mine-2"]);
    expect(trackingRow.manual_followed_at?.toISOString()).toBe(manualFollowedAt.toISOString());
    expect(trackingRow.participated_at).toBeDefined();
  });

  it("seeds missing progress to the thread's latest message instead of the historical anchor", async () => {
    const user = await createVerifiedUser();
    const listId = await createList();
    const thread = await createThreadWithMessages(listId, [
      { fromEmail: "other@example.com", key: "other-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)) },
      { fromEmail: user.email, key: "mine-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 1, 0)) },
      { fromEmail: user.email, key: "mine-2", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 2, 0)) },
      { fromEmail: "other@example.com", key: "other-2", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 3, 0)) },
    ]);

    const result = await runHistoricalParticipationBackfill({
      batchSize: 1,
      maxUsers: 1,
      startAfterUserId: previousUserId(user.id),
    });

    expect(result.progressSeeded).toBe(1);

    const trackingRow = await db
      .selectFrom("thread_tracking")
      .select("anchor_message_id")
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    const progressRow = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(String(trackingRow.anchor_message_id)).toBe(thread.messageIds["mine-2"]);
    expect(String(progressRow.last_read_message_id)).toBe(thread.messageIds["other-2"]);
  });

  it("is idempotent on rerun and leaves existing progress untouched", async () => {
    const user = await createVerifiedUser();
    const listId = await createList();
    const thread = await createThreadWithMessages(listId, [
      { fromEmail: user.email, key: "mine-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)) },
      { fromEmail: "other@example.com", key: "other-1", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 1, 0)) },
      { fromEmail: "other@example.com", key: "other-2", sentAt: new Date(Date.UTC(2024, 0, 1, 0, 2, 0)) },
    ]);

    const firstRun = await runHistoricalParticipationBackfill({
      batchSize: 1,
      maxUsers: 1,
      startAfterUserId: previousUserId(user.id),
    });
    expect(firstRun.progressSeeded).toBe(1);

    const laterMessage = await db
      .insertInto("messages")
      .values({
        body: null,
        from_email: "other@example.com",
        from_name: "Backfill Tester",
        in_reply_to: null,
        list_id: listId,
        message_id: `msg-${uid()}`,
        refs: null,
        sent_at: new Date(Date.UTC(2024, 0, 1, 0, 3, 0)),
        subject: "other-3",
        thread_id: thread.threadId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    createdMessageIds.push(String(laterMessage.id));

    const secondRun = await runHistoricalParticipationBackfill({
      batchSize: 1,
      maxUsers: 1,
      startAfterUserId: previousUserId(user.id),
    });

    expect(secondRun.progressSeeded).toBe(0);

    const trackingCountRow = await db
      .selectFrom("thread_tracking")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    const progressCountRow = await db
      .selectFrom("thread_read_progress")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    const progressRow = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(Number(trackingCountRow.count)).toBe(1);
    expect(Number(progressCountRow.count)).toBe(1);
    expect(String(progressRow.last_read_message_id)).toBe(thread.messageIds["other-2"]);
  });
});
