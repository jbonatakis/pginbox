import { describe, expect, it } from "bun:test";
import {
  buildMailboxPathMap,
  type FastmailPushEvent,
} from "../../src/server/services/ingestion/fastmail-jmap";
import { shouldIgnorePushEvent } from "../../src/server/services/ingestion/mailbox-ingest.service";
import { parseMessageWithPython } from "../../src/server/services/ingestion/python-message-parser";

describe("mailbox ingest helpers", () => {
  it("builds full nested mailbox paths from parent ids", () => {
    const pathMap = buildMailboxPathMap([
      { id: "root", name: "pginbox.dev", parentId: null },
      { id: "hackers", name: "pgsql-hackers", parentId: "root" },
      { id: "docs", name: "pgsql-docs", parentId: "root" },
    ]);

    expect(pathMap.get("root")).toBe("pginbox.dev");
    expect(pathMap.get("hackers")).toBe("pginbox.dev/pgsql-hackers");
    expect(pathMap.get("docs")).toBe("pginbox.dev/pgsql-docs");
  });

  it("ignores Fastmail connect bootstrap push events", () => {
    const connectEvent: FastmailPushEvent = {
      data: JSON.stringify({
        changed: { account: { Email: "J1" } },
        type: "connect",
      }),
      event: "message",
      id: "20307",
    };
    const deliveryEvent: FastmailPushEvent = {
      data: JSON.stringify({
        changed: { account: { Email: "J2" } },
        type: "delivery",
      }),
      event: "message",
      id: "20308",
    };

    expect(shouldIgnorePushEvent(connectEvent)).toBe(true);
    expect(shouldIgnorePushEvent(deliveryEvent)).toBe(false);
  });

  it("parses one raw RFC822 message through the Python bridge", async () => {
    const parsed = await parseMessageWithPython({
      listId: 7,
      pythonBin: "python3",
      rawRfc822: Buffer.from(`Date: Fri, 11 Apr 2026 00:10:40 +0000
From: pgsql-hackers Owner <pgsql-hackers-owner@lists.postgresql.org>
To: Jack Bonatakis <pgsql-hackers@pginbox.dev>
Subject: Test mail for pgsql-hackers
Message-ID: <177586624039.1167.15367935530746720994@malur.postgresql.org>
Content-Type: text/plain; charset="utf-8"

Hello!
`),
    });

    expect(parsed.list_id).toBe(7);
    expect(parsed.message_id).toBe("<177586624039.1167.15367935530746720994@malur.postgresql.org>");
    expect(parsed.subject).toBe("Test mail for pgsql-hackers");
    expect(parsed.body).toBe("Hello!\n");
    expect(parsed.warnings).toEqual([]);
  });
});
