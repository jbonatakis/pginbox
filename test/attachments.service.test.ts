import { describe, expect, it } from "bun:test";
import { dedupeAttachmentRows, type AttachmentSummaryRow } from "../src/server/services/attachments.service";

describe("dedupeAttachmentRows", () => {
  it("collapses duplicate attachment metadata within a message", () => {
    const rows: AttachmentSummaryRow[] = [
      {
        id: "1",
        filename: "patch.diff",
        content_type: "text/x-diff",
        size_bytes: 123,
        has_content: true,
      },
      {
        id: "2",
        filename: "patch.diff",
        content_type: "text/x-diff",
        size_bytes: 123,
        has_content: true,
      },
      {
        id: "3",
        filename: "notes.txt",
        content_type: "text/plain",
        size_bytes: 50,
        has_content: true,
      },
    ];

    expect(dedupeAttachmentRows(rows)).toEqual([rows[0], rows[2]]);
  });

  it("prefers the duplicate row that has extracted text", () => {
    const rows: AttachmentSummaryRow[] = [
      {
        id: "1",
        filename: "archive.gz",
        content_type: "application/gzip",
        size_bytes: 1024,
        has_content: false,
      },
      {
        id: "2",
        filename: "archive.gz",
        content_type: "application/gzip",
        size_bytes: 1024,
        has_content: true,
      },
    ];

    expect(dedupeAttachmentRows(rows)).toEqual([rows[1]]);
  });
});
