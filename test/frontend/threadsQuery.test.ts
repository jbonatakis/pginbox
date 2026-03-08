import { describe, expect, it } from "bun:test";
import {
  THREADS_QUERY_DEFAULT_LIMIT,
  applyThreadsFilterPatch,
  parseThreadsQuery,
  parseThreadsDetailContext,
  serializeThreadsDetailContext,
  serializeThreadsQuery,
  updateThreadsQueryState,
  updateThreadsSearch,
  withThreadsRestoreScroll,
} from "../../src/frontend/lib/state/threadsQuery";

describe("threads query state", () => {
  it("parses known query keys from location.search", () => {
    const parsed = parseThreadsQuery(
      "?to=2025-01-04&list=pgsql-hackers&limit=200&search=srch_01ABCXYZ&cursor=abc123&from=2025-01-03"
    );

    expect(parsed).toEqual({
      cursor: "abc123",
      from: "2025-01-03T00:00:00.000Z",
      limit: 100,
      list: "pgsql-hackers",
      search: "srch_01ABCXYZ",
      to: "2025-01-04T00:00:00.000Z",
    });
  });

  it("defaults limit to 25 and clamps to 1..100", () => {
    expect(parseThreadsQuery("").limit).toBe(THREADS_QUERY_DEFAULT_LIMIT);
    expect(parseThreadsQuery("?limit=0").limit).toBe(1);
    expect(parseThreadsQuery("?limit=999").limit).toBe(100);
    expect(parseThreadsQuery("?limit=not-a-number").limit).toBe(THREADS_QUERY_DEFAULT_LIMIT);
  });

  it("ignores invalid dates without crashing", () => {
    const parsed = parseThreadsQuery("?from=not-a-date&to=also-not-a-date");

    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });

  it("serializes with deterministic key ordering", () => {
    const serialized = serializeThreadsQuery({
      cursor: "c42",
      from: "2025-01-03",
      limit: 50,
      list: "pgsql-hackers",
      search: "srch_opaque",
      to: "2025-01-04",
    });

    expect(serialized).toBe(
      "?list=pgsql-hackers&from=2025-01-03T00%3A00%3A00.000Z&to=2025-01-04T00%3A00%3A00.000Z&search=srch_opaque&cursor=c42&limit=50"
    );
  });

  it("treats search as an opaque id and rejects semantic prompt text", () => {
    expect(parseThreadsQuery("?search=how%20does%20vacuum%20work").search).toBeUndefined();
    expect(serializeThreadsQuery({ search: "find messages about index bloat" })).toBe("");
    expect(serializeThreadsQuery({ search: "srch_opaque-token" })).toBe("?search=srch_opaque-token");
  });

  it("updates state and search strings through typed patches", () => {
    const nextState = updateThreadsQueryState(
      parseThreadsQuery("?list=pgsql-hackers&limit=25&cursor=abc"),
      { cursor: null, limit: 80, search: "srch_123" }
    );
    expect(nextState).toEqual({
      limit: 80,
      list: "pgsql-hackers",
      search: "srch_123",
    });

    const nextSearch = updateThreadsSearch("?list=pgsql-hackers&limit=25&cursor=abc", {
      cursor: null,
      limit: 80,
      search: "srch_123",
    });
    expect(nextSearch).toBe("?list=pgsql-hackers&search=srch_123&limit=80");
  });

  it("clears cursor when a non-cursor filter patch is applied", () => {
    const baseState = parseThreadsQuery("?list=pgsql-hackers&cursor=cursor_1&limit=25");
    const nextState = applyThreadsFilterPatch(baseState, { limit: 50 });

    expect(nextState).toEqual({
      limit: 50,
      list: "pgsql-hackers",
    });
  });

  it("keeps cursor updates intact when only cursor is patched", () => {
    const baseState = parseThreadsQuery("?list=pgsql-hackers&cursor=cursor_1");
    const nextState = applyThreadsFilterPatch(baseState, { cursor: "cursor_2" });

    expect(nextState).toEqual({
      cursor: "cursor_2",
      limit: 25,
      list: "pgsql-hackers",
    });
  });

  it("round-trips detail context with scroll restoration metadata", () => {
    const parsed = parseThreadsDetailContext("?list=pgsql-hackers&cursor=c42&_scrollY=1440");

    expect(parsed).toEqual({
      query: {
        cursor: "c42",
        limit: 25,
        list: "pgsql-hackers",
      },
      restoreScrollY: 1440,
    });

    expect(serializeThreadsDetailContext(parsed.query, parsed.restoreScrollY)).toBe(
      "?list=pgsql-hackers&cursor=c42&_scrollY=1440"
    );
  });

  it("adds and removes restore-scroll query metadata", () => {
    expect(withThreadsRestoreScroll("?list=pgsql-hackers", 120)).toBe(
      "?list=pgsql-hackers&_scrollY=120"
    );
    expect(withThreadsRestoreScroll("?list=pgsql-hackers&_scrollY=120", null)).toBe(
      "?list=pgsql-hackers"
    );
  });
});
