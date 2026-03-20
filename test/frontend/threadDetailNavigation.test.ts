import { describe, expect, it } from "bun:test";
import {
  buildThreadCanonicalSharePath,
  getThreadsDetailHistoryContext,
  withThreadsDetailHistoryContext,
  withoutThreadsDetailHistoryContext,
} from "../../src/frontend/lib/threadDetailNavigation";

describe("thread detail navigation helpers", () => {
  it("stores and reads thread-list context from history state", () => {
    const nextState = withThreadsDetailHistoryContext(
      { existing: "value" },
      "?limit=25&list=pgsql-hackers&cursor=abc",
      1440
    );

    expect(nextState).toEqual({
      existing: "value",
      threadsDetailContext: {
        search: "?list=pgsql-hackers&cursor=abc",
        restoreScrollY: 1440,
      },
    });

    expect(getThreadsDetailHistoryContext(nextState)).toEqual({
      search: "?list=pgsql-hackers&cursor=abc",
      restoreScrollY: 1440,
    });
  });

  it("normalizes missing or invalid history state safely", () => {
    expect(getThreadsDetailHistoryContext(null)).toBeNull();
    expect(getThreadsDetailHistoryContext({})).toBeNull();
    expect(getThreadsDetailHistoryContext({ threadsDetailContext: { search: "?limit=999", restoreScrollY: -7 } })).toEqual({
      search: "?limit=100",
      restoreScrollY: 0,
    });
  });

  it("removes thread-list context without disturbing other history state", () => {
    expect(
      withoutThreadsDetailHistoryContext({
        existing: "value",
        threadsDetailContext: { search: "?list=pgsql-hackers", restoreScrollY: 120 },
      })
    ).toEqual({
      existing: "value",
    });

    expect(
      withoutThreadsDetailHistoryContext({
        threadsDetailContext: { search: "?list=pgsql-hackers", restoreScrollY: 120 },
      })
    ).toBeNull();
  });

  it("builds canonical thread share paths without list context", () => {
    expect(buildThreadCanonicalSharePath("pgsql/foo bar", 3, 5, "#message-11")).toBe(
      "/t/pgsql%2Ffoo%20bar?page=3#message-11"
    );

    expect(buildThreadCanonicalSharePath("pgsql/foo bar", 5, 5, "#message-11")).toBe(
      "/t/pgsql%2Ffoo%20bar#message-11"
    );

    expect(buildThreadCanonicalSharePath("pgsql/foo bar", 5, 5)).toBe(
      "/t/pgsql%2Ffoo%20bar"
    );
  });
});
