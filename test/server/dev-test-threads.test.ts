import { describe, expect, it } from "bun:test";
import {
  buildMessagePlans,
  defaultFirstSentAt,
  parseCliArgs,
  type AddCommandOptions,
  type CreateCommandOptions,
} from "../../src/server/dev/test-threads";

describe("dev test thread CLI parsing", () => {
  it("parses create with defaults", () => {
    const parsed = parseCliArgs(["create", "--list", "pgsql-hackers"]) as CreateCommandOptions;

    expect(parsed.command).toBe("create");
    expect(parsed.list).toBe("pgsql-hackers");
    expect(parsed.count).toBe(1);
    expect(parsed.createList).toBe(false);
    expect(parsed.useThreading).toBe(true);
  });

  it("parses add with explicit options", () => {
    const parsed = parseCliArgs([
      "add",
      "--thread",
      "dev-thread-123",
      "--count",
      "3",
      "--reply-to",
      "dev-msg-1",
      "--json",
      "--no-threading",
    ]) as AddCommandOptions;

    expect(parsed.command).toBe("add");
    expect(parsed.threadId).toBe("dev-thread-123");
    expect(parsed.count).toBe(3);
    expect(parsed.replyTo).toBe("dev-msg-1");
    expect(parsed.json).toBe(true);
    expect(parsed.useThreading).toBe(false);
  });
});

describe("dev test thread message planning", () => {
  it("chains create messages together by default", () => {
    const firstSentAt = new Date(Date.UTC(2026, 2, 17, 12, 0, 0));
    const plans = buildMessagePlans({
      body: "hello",
      count: 3,
      firstSentAt,
      fromEmail: "dev@example.com",
      fromName: "Dev",
      listId: 1,
      mode: "create",
      parent: null,
      spacingSeconds: 30,
      subject: "Test thread",
      threadId: "dev-thread-1",
      useThreading: true,
    });

    expect(plans).toHaveLength(3);
    expect(plans[0]?.in_reply_to).toBeNull();
    expect(plans[0]?.refs).toBeNull();
    expect(plans[1]?.in_reply_to).toBe(plans[0]?.message_id);
    expect(plans[1]?.refs).toEqual([plans[0]?.message_id]);
    expect(plans[2]?.in_reply_to).toBe(plans[1]?.message_id);
    expect(plans[2]?.refs).toEqual([plans[0]?.message_id, plans[1]?.message_id]);
    expect(plans[2]?.sent_at?.toISOString()).toBe("2026-03-17T12:01:00.000Z");
  });

  it("starts add messages from the chosen parent reference chain", () => {
    const plans = buildMessagePlans({
      body: null,
      count: 2,
      firstSentAt: new Date(Date.UTC(2026, 2, 17, 12, 0, 0)),
      fromEmail: "dev@example.com",
      fromName: "Dev",
      listId: 1,
      mode: "add",
      parent: {
        messageId: "existing-parent",
        refs: ["root-message"],
      },
      spacingSeconds: 60,
      subject: "Re: Test thread",
      threadId: "dev-thread-1",
      useThreading: true,
    });

    expect(plans[0]?.in_reply_to).toBe("existing-parent");
    expect(plans[0]?.refs).toEqual(["root-message", "existing-parent"]);
    expect(plans[1]?.refs).toEqual(["root-message", "existing-parent", plans[0]?.message_id]);
  });

  it("chooses now when it is later than the nominal next sent_at", () => {
    const now = new Date(Date.UTC(2026, 2, 17, 12, 0, 30));
    const value = defaultFirstSentAt(new Date(Date.UTC(2026, 2, 17, 12, 0, 0)), 10, now);
    expect(value.toISOString()).toBe(now.toISOString());
  });
});
