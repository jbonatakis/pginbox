export const THREADS_QUERY_DEFAULT_LIMIT = 25;
export const THREADS_QUERY_MIN_LIMIT = 1;
export const THREADS_QUERY_MAX_LIMIT = 100;
export const THREADS_RESTORE_SCROLL_PARAM = "_scrollY";

const OPAQUE_SEARCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FILTER_PATCH_KEYS: Array<keyof ThreadsQueryPatch> = ["from", "limit", "list", "search", "to"];

export interface ThreadsQueryState {
  cursor?: string;
  from?: string;
  limit: number;
  list?: string;
  search?: string;
  to?: string;
}

export interface ThreadsQueryInput {
  cursor?: string | null;
  from?: Date | string | null;
  limit?: number | null;
  list?: string | null;
  search?: string | null;
  to?: Date | string | null;
}

export interface ThreadsQueryPatch extends ThreadsQueryInput {}

export interface LocationSearchLike {
  search: string;
}

export interface ThreadsDetailContext {
  query: ThreadsQueryState;
  restoreScrollY?: number;
}

export function createDefaultThreadsQueryState(): ThreadsQueryState {
  return { limit: THREADS_QUERY_DEFAULT_LIMIT };
}

export function clampThreadsQueryLimit(limit?: number | null): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return THREADS_QUERY_DEFAULT_LIMIT;
  }

  const normalized = Math.trunc(limit);
  return Math.max(THREADS_QUERY_MIN_LIMIT, Math.min(THREADS_QUERY_MAX_LIMIT, normalized));
}

export function parseThreadsQuery(search: string | URLSearchParams): ThreadsQueryState {
  const params = toSearchParams(search);

  return normalizeThreadsQueryState({
    cursor: params.get("cursor"),
    from: params.get("from"),
    limit: parseOptionalNumber(params.get("limit")),
    list: params.get("list"),
    search: params.get("search"),
    to: params.get("to"),
  });
}

export function parseThreadsQueryFromLocation(locationLike: LocationSearchLike): ThreadsQueryState {
  return parseThreadsQuery(locationLike.search);
}

export function normalizeThreadsQueryState(
  state: ThreadsQueryInput = {}
): ThreadsQueryState {
  const normalized: ThreadsQueryState = {
    limit: clampThreadsQueryLimit(state.limit),
  };

  const list = normalizeQueryText(state.list);
  if (list) normalized.list = list;

  const from = normalizeQueryDate(state.from);
  if (from) normalized.from = from;

  const to = normalizeQueryDate(state.to);
  if (to) normalized.to = to;

  const search = normalizeOpaqueSearchId(state.search);
  if (search) normalized.search = search;

  const cursor = normalizeQueryText(state.cursor);
  if (cursor) normalized.cursor = cursor;

  return normalized;
}

export function updateThreadsQueryState(
  current: ThreadsQueryState,
  patch: ThreadsQueryPatch
): ThreadsQueryState {
  return normalizeThreadsQueryState({ ...current, ...patch });
}

export function updateThreadsSearch(
  currentSearch: string,
  patch: ThreadsQueryPatch
): string {
  const currentState = parseThreadsQuery(currentSearch);
  const nextState = updateThreadsQueryState(currentState, patch);
  return serializeThreadsQuery(nextState);
}

export function applyThreadsFilterPatch(
  current: ThreadsQueryState,
  patch: ThreadsQueryPatch
): ThreadsQueryState {
  const shouldClearCursor = FILTER_PATCH_KEYS.some((key) => patch[key] !== undefined);
  const nextPatch = shouldClearCursor ? { ...patch, cursor: null } : patch;
  return updateThreadsQueryState(current, nextPatch);
}

export function parseThreadsDetailContext(search: string | URLSearchParams): ThreadsDetailContext {
  const params = toSearchParams(search);
  const query = parseThreadsQuery(params);
  const restoreScrollY = normalizeRestoreScroll(params.get(THREADS_RESTORE_SCROLL_PARAM));

  if (restoreScrollY === undefined) {
    return { query };
  }

  return { query, restoreScrollY };
}

export function serializeThreadsDetailContext(
  query: ThreadsQueryInput,
  restoreScrollY?: number | null
): string {
  const querySearch = serializeThreadsQuery(query);
  return withThreadsRestoreScroll(querySearch, restoreScrollY);
}

export function withThreadsRestoreScroll(
  search: string | URLSearchParams,
  restoreScrollY?: number | null
): string {
  const params = toSearchParams(search);
  const normalizedRestoreScrollY = normalizeRestoreScroll(restoreScrollY);

  if (normalizedRestoreScrollY === undefined) {
    params.delete(THREADS_RESTORE_SCROLL_PARAM);
  } else {
    params.set(THREADS_RESTORE_SCROLL_PARAM, String(normalizedRestoreScrollY));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function serializeThreadsQuery(state: ThreadsQueryInput): string {
  const normalized = normalizeThreadsQueryState(state);
  const params = new URLSearchParams();

  if (normalized.list) params.set("list", normalized.list);
  if (normalized.from) params.set("from", normalized.from);
  if (normalized.to) params.set("to", normalized.to);
  if (normalized.search) params.set("search", normalized.search);
  if (normalized.cursor) params.set("cursor", normalized.cursor);
  if (normalized.limit !== THREADS_QUERY_DEFAULT_LIMIT) {
    params.set("limit", String(normalized.limit));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeQueryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeQueryDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) return undefined;

  return parsed.toISOString();
}

function normalizeOpaqueSearchId(value: unknown): string | undefined {
  const normalized = normalizeQueryText(value);
  if (!normalized) return undefined;
  if (!OPAQUE_SEARCH_ID_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function normalizeRestoreScroll(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;

  return Math.max(0, Math.trunc(parsed));
}

function parseOptionalNumber(value: string | null): number | null {
  if (value === null) return null;
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function toSearchParams(value: string | URLSearchParams): URLSearchParams {
  if (value instanceof URLSearchParams) {
    return new URLSearchParams(value.toString());
  }

  const normalized = value.startsWith("?") ? value.slice(1) : value;
  return new URLSearchParams(normalized);
}
