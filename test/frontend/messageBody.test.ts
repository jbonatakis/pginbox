import { describe, expect, it } from "bun:test";
import { parseMessageBody } from "../../src/frontend/lib/messageBody";

describe("parseMessageBody", () => {
  it("returns fallback text for empty message bodies", () => {
    expect(parseMessageBody(null)).toEqual([
      {
        depth: 0,
        parts: [{ type: "text", value: "No message body available." }],
        text: "No message body available.",
        type: "text",
      },
    ]);
  });

  it("groups consecutive non-quoted lines into one text block", () => {
    expect(parseMessageBody("Hi,\n\nThanks for the review.")).toEqual([
      {
        depth: 0,
        parts: [{ type: "text", value: "Hi,\n\nThanks for the review." }],
        text: "Hi,\n\nThanks for the review.",
        type: "text",
      },
    ]);
  });

  it("renders quoted email lines as quote blocks", () => {
    expect(
      parseMessageBody(
        "Hi,\n\nOn 2025-08-31 16:57:01 -0700, Lukas Fittl wrote:\n> First line\n> Second line"
      )
    ).toEqual([
      {
        depth: 0,
        parts: [{ type: "text", value: "Hi,\n\nOn 2025-08-31 16:57:01 -0700, Lukas Fittl wrote:" }],
        text: "Hi,\n\nOn 2025-08-31 16:57:01 -0700, Lukas Fittl wrote:",
        type: "text",
      },
      {
        depth: 1,
        parts: [{ type: "text", value: "First line\nSecond line" }],
        text: "First line\nSecond line",
        type: "quote",
      },
    ]);
  });

  it("keeps separate blocks when quote depth changes", () => {
    expect(parseMessageBody("> outer\n>> inner\n> back to outer")).toEqual([
      {
        depth: 1,
        parts: [{ type: "text", value: "outer" }],
        text: "outer",
        type: "quote",
      },
      {
        depth: 2,
        parts: [{ type: "text", value: "inner" }],
        text: "inner",
        type: "quote",
      },
      {
        depth: 1,
        parts: [{ type: "text", value: "back to outer" }],
        text: "back to outer",
        type: "quote",
      },
    ]);
  });

  it("supports quote markers separated by spaces and keeps links clickable inside quotes", () => {
    expect(parseMessageBody("> > See https://example.com/patch(1).")).toEqual([
      {
        depth: 2,
        parts: [
          { type: "text", value: "See " },
          {
            type: "link",
            value: "https://example.com/patch(1)",
            href: "https://example.com/patch(1)",
          },
          { type: "text", value: "." },
        ],
        text: "See https://example.com/patch(1).",
        type: "quote",
      },
    ]);
  });

  it("keeps git commit hashes clickable inside quote blocks", () => {
    expect(parseMessageBody("> commit a8677e3")).toEqual([
      {
        depth: 1,
        parts: [
          { type: "text", value: "commit " },
          {
            type: "link",
            value: "a8677e3",
            href: "https://github.com/postgres/postgres/commit/a8677e3",
          },
        ],
        text: "commit a8677e3",
        type: "quote",
      },
    ]);
  });
});
