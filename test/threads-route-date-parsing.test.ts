import { describe, expect, it } from "bun:test";
import { parseThreadsFromDate, parseThreadsToDate } from "../src/server/routes/threads";

describe("thread route date parsing", () => {
  it("parses date-only from filters at the start of the UTC day", () => {
    expect(parseThreadsFromDate("2025-03-14")?.toISOString()).toBe("2025-03-14T00:00:00.000Z");
  });

  it("parses date-only to filters at the end of the UTC day", () => {
    expect(parseThreadsToDate("2025-03-14")?.toISOString()).toBe("2025-03-14T23:59:59.999Z");
  });

  it("preserves exact timestamps for non-date-only filters", () => {
    expect(parseThreadsToDate("2025-03-14T00:00:00.000Z")?.toISOString()).toBe(
      "2025-03-14T00:00:00.000Z"
    );
  });

  it("rejects invalid calendar dates", () => {
    expect(parseThreadsFromDate("2025-02-30")).toBeNull();
    expect(parseThreadsToDate("not-a-date")).toBeNull();
  });
});
