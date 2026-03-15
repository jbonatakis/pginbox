import { describe, expect, it } from "bun:test";
import { linkifyPlainText } from "../../src/frontend/lib/linkify";

describe("linkifyPlainText", () => {
  it("returns fallback text for empty message bodies", () => {
    expect(linkifyPlainText(null)).toEqual([
      { type: "text", value: "No message body available." },
    ]);
    expect(linkifyPlainText("")).toEqual([
      { type: "text", value: "No message body available." },
    ]);
  });

  it("leaves plain text untouched when no URL is present", () => {
    expect(linkifyPlainText("No links here.")).toEqual([{ type: "text", value: "No links here." }]);
  });

  it("splits text around detected URLs", () => {
    expect(linkifyPlainText("See https://example.com/docs for details.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "https://example.com/docs", href: "https://example.com/docs" },
      { type: "text", value: " for details." },
    ]);
  });

  it("strips trailing punctuation that should not be part of the URL", () => {
    expect(linkifyPlainText("Docs: https://example.com/test).")).toEqual([
      { type: "text", value: "Docs: " },
      { type: "link", value: "https://example.com/test", href: "https://example.com/test" },
      { type: "text", value: ")." },
    ]);

    expect(linkifyPlainText("Patch is at https://example.com/foo], thanks")).toEqual([
      { type: "text", value: "Patch is at " },
      { type: "link", value: "https://example.com/foo", href: "https://example.com/foo" },
      { type: "text", value: "], thanks" },
    ]);
  });

  it("keeps balanced parentheses when they are part of the URL", () => {
    expect(linkifyPlainText("Spec: https://example.com/func(test)")).toEqual([
      { type: "text", value: "Spec: " },
      {
        type: "link",
        value: "https://example.com/func(test)",
        href: "https://example.com/func(test)",
      },
    ]);
  });
});
