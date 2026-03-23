import { threadDetailPath } from "../router";
import { parseHashAnchorId } from "./hashAnchor";
import { parseThreadsQuery, serializeThreadsQuery, withThreadDetailPage } from "./state/threadsQuery";

const THREADS_DETAIL_HISTORY_CONTEXT_KEY = "threadsDetailContext";

export interface ThreadsDetailHistoryContext {
  search: string;
  restoreScrollY?: number;
  pageCursors?: Array<string | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePageCursors = (value: unknown): Array<string | undefined> | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: Array<string | undefined> = [];
  for (const entry of value) {
    if (entry === undefined || entry === null) {
      result.push(undefined);
    } else if (typeof entry === "string") {
      result.push(entry.length > 0 ? entry : undefined);
    } else {
      return undefined;
    }
  }
  return result;
};

const normalizeRestoreScroll = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.trunc(parsed));
};

const normalizeThreadsSearch = (search: string): string => serializeThreadsQuery(parseThreadsQuery(search));

export function getThreadsDetailHistoryContext(state: unknown): ThreadsDetailHistoryContext | null {
  if (!isRecord(state)) return null;

  const rawContext = state[THREADS_DETAIL_HISTORY_CONTEXT_KEY];
  if (!isRecord(rawContext)) return null;

  const search = typeof rawContext.search === "string" ? normalizeThreadsSearch(rawContext.search) : "";
  const restoreScrollY = normalizeRestoreScroll(rawContext.restoreScrollY);
  const pageCursors = normalizePageCursors(rawContext.pageCursors);

  const context: ThreadsDetailHistoryContext = { search };
  if (restoreScrollY !== undefined) context.restoreScrollY = restoreScrollY;
  if (pageCursors !== undefined) context.pageCursors = pageCursors;
  return context;
}

export function withThreadsDetailHistoryContext(
  state: unknown,
  search: string,
  restoreScrollY?: number | null,
  pageCursors?: Array<string | undefined>
): Record<string, unknown> {
  const nextState = isRecord(state) ? { ...state } : {};
  const nextContext: ThreadsDetailHistoryContext = {
    search: normalizeThreadsSearch(search),
  };
  const normalizedRestoreScrollY = normalizeRestoreScroll(restoreScrollY);
  if (normalizedRestoreScrollY !== undefined) {
    nextContext.restoreScrollY = normalizedRestoreScrollY;
  }
  const normalizedPageCursors = normalizePageCursors(pageCursors);
  if (normalizedPageCursors !== undefined) {
    nextContext.pageCursors = normalizedPageCursors;
  }

  nextState[THREADS_DETAIL_HISTORY_CONTEXT_KEY] = nextContext;
  return nextState;
}

export function withoutThreadsDetailHistoryContext(state: unknown): Record<string, unknown> | null {
  if (!isRecord(state)) return null;

  const nextState = { ...state };
  delete nextState[THREADS_DETAIL_HISTORY_CONTEXT_KEY];
  return Object.keys(nextState).length > 0 ? nextState : null;
}

export function buildThreadCanonicalSharePath(
  threadId: string,
  page: number,
  totalPages: number,
  hash = ""
): string {
  const search = withThreadDetailPage("", page < totalPages ? page : null);
  const anchorId = parseHashAnchorId(hash);
  const nextHash = anchorId ? `#${anchorId}` : "";

  return `${threadDetailPath(threadId)}${search}${nextHash}`;
}
