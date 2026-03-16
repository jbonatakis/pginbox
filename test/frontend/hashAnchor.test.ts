import { describe, expect, it } from "bun:test";
import {
  buildHashAnchorApplicationKey,
  parseHashAnchorId,
} from "../../src/frontend/lib/hashAnchor";

describe("hash anchor helpers", () => {
  it("returns null for empty or whitespace-only hashes", () => {
    expect(parseHashAnchorId("")).toBeNull();
    expect(parseHashAnchorId("#")).toBeNull();
    expect(parseHashAnchorId("#   ")).toBeNull();
  });

  it("decodes valid hash anchors and trims surrounding whitespace", () => {
    expect(parseHashAnchorId("#message-abc-5")).toBe("message-abc-5");
    expect(parseHashAnchorId("#message%20abc%205")).toBe("message abc 5");
    expect(parseHashAnchorId("  message-abc-5  ")).toBe("message-abc-5");
  });

  it("keeps malformed escape sequences as literal anchor text", () => {
    expect(parseHashAnchorId("#message-%E0%A4%A")).toBe("message-%E0%A4%A");
  });

  it("builds a scoped application key only when an anchor exists", () => {
    expect(buildHashAnchorApplicationKey("thread-1:page-2", "#message-abc-5")).toBe(
      "thread-1:page-2:message-abc-5"
    );
    expect(buildHashAnchorApplicationKey("thread-1:page-2", "#")).toBeNull();
  });
});
