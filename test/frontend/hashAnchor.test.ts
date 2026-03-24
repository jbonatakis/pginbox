import { describe, expect, it } from "bun:test";
import {
  buildHashAnchorApplicationKey,
  parseHashAnchorId,
  scrollToHashAnchor,
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

  it("updates the current hash and scrolls to an existing anchor", () => {
    const replaceStateCalls: Array<[unknown, string, string | URL | null | undefined]> = [];
    const scrollCalls: ScrollIntoViewOptions[] = [];
    const environment = {
      document: {
        getElementById: (id: string) =>
          id === "message-99"
            ? {
                scrollIntoView: (options?: ScrollIntoViewOptions) => {
                  scrollCalls.push(options ?? {});
                },
              }
            : null,
      },
      history: {
        replaceState: (state: unknown, unused: string, url?: string | URL | null) => {
          replaceStateCalls.push([state, unused, url]);
        },
        state: { preserve: true },
      },
      location: {
        hash: "#message-12",
        pathname: "/t/thread-1",
        search: "?page=2",
      },
    };

    expect(scrollToHashAnchor("message-99", { environment })).toBe(true);
    expect(replaceStateCalls).toEqual([[{ preserve: true }, "", "/t/thread-1?page=2#message-99"]]);
    expect(scrollCalls).toEqual([{ behavior: "auto", block: "start" }]);
  });

  it("scrolls without replacing history when the current hash already matches", () => {
    let replaceStateCalls = 0;
    let scrollCalls = 0;
    const environment = {
      document: {
        getElementById: (id: string) =>
          id === "message-12"
            ? {
                scrollIntoView: () => {
                  scrollCalls += 1;
                },
              }
            : null,
      },
      history: {
        replaceState: () => {
          replaceStateCalls += 1;
        },
        state: null,
      },
      location: {
        hash: "#message-12",
        pathname: "/t/thread-1",
        search: "?page=2",
      },
    };

    expect(scrollToHashAnchor("message-12", { behavior: "smooth", environment })).toBe(true);
    expect(replaceStateCalls).toBe(0);
    expect(scrollCalls).toBe(1);
  });

  it("returns false when the target anchor is missing", () => {
    let replaceStateCalls = 0;
    const environment = {
      document: {
        getElementById: () => null,
      },
      history: {
        replaceState: () => {
          replaceStateCalls += 1;
        },
        state: null,
      },
      location: {
        hash: "",
        pathname: "/t/thread-1",
        search: "",
      },
    };

    expect(scrollToHashAnchor("message-404", { environment })).toBe(false);
    expect(replaceStateCalls).toBe(0);
  });
});
