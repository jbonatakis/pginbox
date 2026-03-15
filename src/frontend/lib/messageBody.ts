import { linkifyPlainText, type LinkifiedTextPart } from "./linkify";

export interface MessageBodyBlock {
  depth: number;
  parts: LinkifiedTextPart[];
  text: string;
  type: "text" | "quote";
}

interface ParsedLine {
  depth: number;
  text: string;
}

function parseQuotedLine(line: string): ParsedLine {
  let cursor = 0;

  while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
    cursor += 1;
  }

  let depth = 0;
  let quoteCursor = cursor;

  while (quoteCursor < line.length && line[quoteCursor] === ">") {
    depth += 1;
    quoteCursor += 1;

    while (
      quoteCursor < line.length &&
      (line[quoteCursor] === " " || line[quoteCursor] === "\t")
    ) {
      quoteCursor += 1;
    }
  }

  if (depth === 0) {
    return { depth: 0, text: line };
  }

  return {
    depth,
    text: line.slice(quoteCursor),
  };
}

function pushBlock(blocks: MessageBodyBlock[], type: "text" | "quote", depth: number, text: string): void {
  const lastBlock = blocks.at(-1);
  if (lastBlock && lastBlock.type === type && lastBlock.depth === depth) {
    lastBlock.text = `${lastBlock.text}\n${text}`;
    lastBlock.parts = linkifyPlainText(lastBlock.text, "");
    return;
  }

  blocks.push({
    depth,
    parts: linkifyPlainText(text, ""),
    text,
    type,
  });
}

// Home-grown quote parsing is intentionally narrow. If we run into many odd mailer
// formats, replace this with a dedicated email quote parser instead of piling on heuristics.
export function parseMessageBody(
  value: string | null,
  emptyText = "No message body available."
): MessageBodyBlock[] {
  const source = value === null || value === "" ? emptyText : value;
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MessageBodyBlock[] = [];

  for (const line of lines) {
    const parsedLine = parseQuotedLine(line);
    const type = parsedLine.depth > 0 ? "quote" : "text";
    pushBlock(blocks, type, parsedLine.depth, parsedLine.text);
  }

  return blocks;
}
