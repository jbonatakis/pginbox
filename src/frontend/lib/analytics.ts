import type { AnalyticsSummary, ByDow, ByHour, ByMonth, TopSender } from "shared/api";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";
import { api, toApiErrorShape, type ApiErrorShape, type GetAnalyticsParams } from "./api";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface AnalyticsSummaryMetric {
  id: "totalMessages" | "totalThreads" | "uniqueSenders" | "monthsIngested";
  label: string;
  value: number;
}

export interface AnalyticsByMonthPoint {
  key: string;
  label: string;
  year: number;
  month: number;
  messages: number;
}

export interface AnalyticsTopSenderPoint {
  email: string | null;
  label: string;
  messages: number;
  name: string | null;
  rank: number;
}

export interface AnalyticsByHourPoint {
  hour: number;
  label: string;
  messages: number;
}

export interface AnalyticsByDowPoint {
  dow: number;
  label: string;
  messages: number;
}

export interface AnalyticsViewModel {
  byDow: AnalyticsByDowPoint[];
  byHour: AnalyticsByHourPoint[];
  byMonth: AnalyticsByMonthPoint[];
  isEmpty: boolean;
  summary: AnalyticsSummary;
  summaryMetrics: AnalyticsSummaryMetric[];
  topSenders: AnalyticsTopSenderPoint[];
}

export type AnalyticsLoadStatus = "idle" | "loading" | "success" | "empty" | "error";

export interface AnalyticsStoreState {
  data: AnalyticsViewModel | null;
  error: ApiErrorShape | null;
  isEmpty: boolean;
  isLoading: boolean;
  loadedAt: string | null;
  status: AnalyticsLoadStatus;
}

export interface AnalyticsLoadOptions {
  listIds?: number[];
  signal?: AbortSignal;
}

export interface AnalyticsStore extends Readable<AnalyticsStoreState> {
  dispose: () => void;
  load: () => Promise<void>;
  retry: () => Promise<void>;
  setListFilter: (listIds: number[]) => Promise<void>;
}

interface AnalyticsEndpointPayload {
  byDow: ByDow[];
  byHour: ByHour[];
  byMonth: ByMonth[];
  summary: AnalyticsSummary;
  topSenders: TopSender[];
}

interface CreateAnalyticsStoreOptions {
  loader?: (options: AnalyticsLoadOptions) => Promise<AnalyticsViewModel>;
}

const initialState: AnalyticsStoreState = {
  data: null,
  error: null,
  isEmpty: false,
  isLoading: false,
  loadedAt: null,
  status: "idle",
};

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeSummary(summary: AnalyticsSummary): AnalyticsSummary {
  return {
    monthsIngested: normalizeCount(summary.monthsIngested),
    totalMessages: normalizeCount(summary.totalMessages),
    totalThreads: normalizeCount(summary.totalThreads),
    uniqueSenders: normalizeCount(summary.uniqueSenders),
  };
}

function toMonthLabel(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleString("en-US", { month: "short", timeZone: "UTC", year: "numeric" });
}

function normalizeByMonth(rows: ByMonth[]): AnalyticsByMonthPoint[] {
  return [...rows]
    .filter((row) => Number.isInteger(row.year) && Number.isInteger(row.month))
    .filter((row) => row.month >= 1 && row.month <= 12)
    .sort((left, right) => left.year - right.year || left.month - right.month)
    .map((row) => ({
      key: `${row.year}-${String(row.month).padStart(2, "0")}`,
      label: toMonthLabel(row.year, row.month),
      messages: normalizeCount(row.messages),
      month: row.month,
      year: row.year,
    }));
}

function normalizeTopSenders(rows: TopSender[]): AnalyticsTopSenderPoint[] {
  return [...rows]
    .map((row) => ({
      count: normalizeCount(row.count),
      email: row.email?.trim() || null,
      name: row.name?.trim() || null,
    }))
    .sort((left, right) => right.count - left.count)
    .map((row, index) => ({
      email: row.email,
      label: row.name ?? row.email ?? "Unknown sender",
      messages: row.count,
      name: row.name,
      rank: index + 1,
    }));
}

function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function normalizeByHour(rows: ByHour[]): AnalyticsByHourPoint[] {
  const byHour = new Map<number, number>();

  for (const row of rows) {
    if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23) continue;
    byHour.set(row.hour, normalizeCount(row.messages));
  }

  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: formatHourLabel(hour),
    messages: byHour.get(hour) ?? 0,
  }));
}

function normalizeByDow(rows: ByDow[]): AnalyticsByDowPoint[] {
  const byDow = new Map<number, number>();

  for (const row of rows) {
    if (!Number.isInteger(row.dow) || row.dow < 0 || row.dow > 6) continue;
    byDow.set(row.dow, normalizeCount(row.messages));
  }

  return DOW_LABELS.map((label, dow) => ({
    dow,
    label,
    messages: byDow.get(dow) ?? 0,
  }));
}

function normalizeSummaryMetrics(summary: AnalyticsSummary): AnalyticsSummaryMetric[] {
  return [
    { id: "totalMessages", label: "Messages", value: summary.totalMessages },
    { id: "totalThreads", label: "Threads", value: summary.totalThreads },
    { id: "uniqueSenders", label: "Senders", value: summary.uniqueSenders },
    { id: "monthsIngested", label: "Months", value: summary.monthsIngested },
  ];
}

function hasPositiveMessages(points: Array<{ messages: number }>): boolean {
  return points.some((point) => point.messages > 0);
}

function isEmptyViewModel(
  summary: AnalyticsSummary,
  byMonth: AnalyticsByMonthPoint[],
  topSenders: AnalyticsTopSenderPoint[],
  byHour: AnalyticsByHourPoint[],
  byDow: AnalyticsByDowPoint[]
): boolean {
  const hasSummaryData =
    summary.totalMessages > 0 ||
    summary.totalThreads > 0 ||
    summary.uniqueSenders > 0 ||
    summary.monthsIngested > 0;
  const hasSeriesData =
    hasPositiveMessages(byMonth) ||
    hasPositiveMessages(byHour) ||
    hasPositiveMessages(byDow) ||
    topSenders.some((sender) => sender.messages > 0);

  return !hasSummaryData && !hasSeriesData;
}

export async function fetchAnalyticsPayload(
  options: AnalyticsLoadOptions = {}
): Promise<AnalyticsEndpointPayload> {
  const { listIds, signal } = options;
  const requestOptions: { signal?: AbortSignal } = {};
  if (signal) requestOptions.signal = signal;
  const params: GetAnalyticsParams = { listIds };

  const [summary, byMonth, topSenders, byHour, byDow] = await Promise.all([
    api.analytics.getSummary(params, requestOptions),
    api.analytics.getByMonth(params, requestOptions),
    api.analytics.getTopSenders(params, requestOptions),
    api.analytics.getByHour(params, requestOptions),
    api.analytics.getByDow(params, requestOptions),
  ]);

  return {
    byDow,
    byHour,
    byMonth,
    summary,
    topSenders,
  };
}

export async function loadAnalyticsViewModel(
  options: AnalyticsLoadOptions = {}
): Promise<AnalyticsViewModel> {
  const payload = await fetchAnalyticsPayload(options);
  const summary = normalizeSummary(payload.summary);
  const byMonth = normalizeByMonth(payload.byMonth);
  const topSenders = normalizeTopSenders(payload.topSenders);
  const byHour = normalizeByHour(payload.byHour);
  const byDow = normalizeByDow(payload.byDow);

  return {
    byDow,
    byHour,
    byMonth,
    isEmpty: isEmptyViewModel(summary, byMonth, topSenders, byHour, byDow),
    summary,
    summaryMetrics: normalizeSummaryMetrics(summary),
    topSenders,
  };
}

export function createAnalyticsStore(options: CreateAnalyticsStoreOptions = {}): AnalyticsStore {
  const load = options.loader ?? loadAnalyticsViewModel;
  const state = writable<AnalyticsStoreState>(initialState);

  let activeRequestId = 0;
  let activeController: AbortController | null = null;
  let currentListIds: number[] = [];

  const setLoadingState = (): void => {
    state.update((current) => ({
      ...current,
      error: null,
      isLoading: true,
      status: "loading",
    }));
  };

  const runLoad = async (): Promise<void> => {
    activeController?.abort();
    activeController = new AbortController();
    const requestId = ++activeRequestId;

    setLoadingState();

    try {
      const data = await load({ listIds: currentListIds, signal: activeController.signal });

      if (requestId !== activeRequestId) return;

      state.set({
        data,
        error: null,
        isEmpty: data.isEmpty,
        isLoading: false,
        loadedAt: new Date().toISOString(),
        status: data.isEmpty ? "empty" : "success",
      });
    } catch (error) {
      if (requestId !== activeRequestId) return;

      const apiError = toApiErrorShape(error);
      if (apiError.code === "ABORTED") return;

      state.set({
        data: null,
        error: apiError,
        isEmpty: false,
        isLoading: false,
        loadedAt: null,
        status: "error",
      });
    }
  };

  const dispose = (): void => {
    activeRequestId += 1;
    activeController?.abort();
    activeController = null;
  };

  const setListFilter = (listIds: number[]): Promise<void> => {
    currentListIds = listIds;
    return runLoad();
  };

  return {
    dispose,
    load: runLoad,
    retry: runLoad,
    setListFilter,
    subscribe: state.subscribe,
  };
}
