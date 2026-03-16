export function parseHashAnchorId(hash: string): string | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const trimmed = rawHash.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function buildHashAnchorApplicationKey(scope: string, hash: string): string | null {
  const anchorId = parseHashAnchorId(hash);

  if (!anchorId) {
    return null;
  }

  return `${scope}:${anchorId}`;
}
