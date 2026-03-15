export type LinkifiedTextPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = new Set([",", ".", "!", "?", ":", ";"]);

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) count += 1;
  }
  return count;
}

function stripTrailingUrlPunctuation(value: string): { url: string; trailing: string } {
  let url = value;
  let trailing = "";

  while (url.length > 0) {
    const lastChar = url.at(-1);
    if (!lastChar) break;

    if (TRAILING_PUNCTUATION.has(lastChar)) {
      trailing = `${lastChar}${trailing}`;
      url = url.slice(0, -1);
      continue;
    }

    if (lastChar === ")" && countChar(url, "(") < countChar(url, ")")) {
      trailing = `${lastChar}${trailing}`;
      url = url.slice(0, -1);
      continue;
    }

    if (lastChar === "]" && countChar(url, "[") < countChar(url, "]")) {
      trailing = `${lastChar}${trailing}`;
      url = url.slice(0, -1);
      continue;
    }

    break;
  }

  return { url, trailing };
}

function toHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function pushText(parts: LinkifiedTextPart[], value: string): void {
  if (value.length === 0) return;

  const lastPart = parts.at(-1);
  if (lastPart?.type === "text") {
    lastPart.value += value;
    return;
  }

  parts.push({ type: "text", value });
}

// Home-grown regex linkification is fine for now. If edge cases pile up, replace this
// helper with a dedicated library instead of making the regex/parser increasingly clever.
export function linkifyPlainText(
  value: string | null,
  emptyText = "No message body available."
): LinkifiedTextPart[] {
  const source = value === null || value === "" ? emptyText : value;
  const parts: LinkifiedTextPart[] = [];
  let cursor = 0;

  for (const match of source.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const rawMatch = match[0];
    const { url: trimmedMatch, trailing } = stripTrailingUrlPunctuation(rawMatch);
    const href = toHttpUrl(trimmedMatch);

    if (href === null) continue;

    if (start > cursor) {
      pushText(parts, source.slice(cursor, start));
    }

    parts.push({ type: "link", value: trimmedMatch, href });

    if (trailing.length > 0) {
      pushText(parts, trailing);
    }

    cursor = start + rawMatch.length;
  }

  if (cursor < source.length) {
    pushText(parts, source.slice(cursor));
  }

  if (parts.length === 0) {
    return [{ type: "text", value: source }];
  }

  return parts;
}
