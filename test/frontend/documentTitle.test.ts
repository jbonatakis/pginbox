import { describe, expect, it } from "bun:test";
import {
  documentTitleForRoute,
  messagePermalinkDocumentTitle,
  threadDetailDocumentTitle,
} from "../../src/frontend/lib/documentTitle";

describe("document title helpers", () => {
  it("uses the thread subject for thread detail pages when available", () => {
    expect(threadDetailDocumentTitle("VACUUM freeze planning", "pgsql/abc123")).toBe(
      "VACUUM freeze planning | pginbox"
    );
  });

  it("falls back to the thread id when the subject is empty", () => {
    expect(threadDetailDocumentTitle("   ", "pgsql/abc123")).toBe("Thread pgsql/abc123 | pginbox");
  });

  it("keeps route-level thread titles on the thread id until data is loaded", () => {
    expect(
      documentTitleForRoute({
        name: "thread-detail",
        pathname: "/threads/pgsql%2Fabc123",
        params: { threadId: "pgsql/abc123" },
      })
    ).toBe("Thread pgsql/abc123 | pginbox");
  });

  it("uses the message id for message permalink routes before redirecting", () => {
    expect(messagePermalinkDocumentTitle("123456")).toBe("Message 123456 | pginbox");
    expect(
      documentTitleForRoute({
        name: "message-permalink",
        pathname: "/m/123456",
        params: { messageId: "123456" },
      })
    ).toBe("Message 123456 | pginbox");
  });
});
