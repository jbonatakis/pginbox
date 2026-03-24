import type {
  AnalyticsAll,
  AnalyticsSummary,
  ByDow,
  ByHour,
  ByMonth,
  ListMessagesLast24h,
  TopSender,
} from "shared/api";
import { Elysia, t } from "elysia";
import * as analytics from "../services/analytics.service";

const listQuery = t.Object({
  list: t.Optional(t.Array(t.String())),
});

function parseListIds(raw: string[] | undefined): number[] {
  if (!raw || raw.length === 0) return [];
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export const analyticsRoutes = new Elysia({ prefix: "/analytics" })
  .get(
    "/summary",
    ({ query }): Promise<AnalyticsSummary> => analytics.getSummary(parseListIds(query.list)),
    { query: listQuery }
  )
  .get(
    "/by-month",
    ({ query }): Promise<ByMonth[]> => analytics.getByMonth(parseListIds(query.list)),
    { query: listQuery }
  )
  .get(
    "/top-senders",
    ({ query }): Promise<TopSender[]> => analytics.getTopSenders(parseListIds(query.list)),
    { query: listQuery }
  )
  .get(
    "/by-hour",
    ({ query }): Promise<ByHour[]> => analytics.getByHour(parseListIds(query.list)),
    { query: listQuery }
  )
  .get(
    "/by-dow",
    ({ query }): Promise<ByDow[]> => analytics.getByDow(parseListIds(query.list)),
    { query: listQuery }
  )
  .get(
    "/all",
    async ({ query }): Promise<AnalyticsAll> => {
      const listIds = parseListIds(query.list);
      const [summary, byMonth, topSenders, byHour, byDow] = await Promise.all([
        analytics.getSummary(listIds),
        analytics.getByMonth(listIds),
        analytics.getTopSenders(listIds),
        analytics.getByHour(listIds),
        analytics.getByDow(listIds),
      ]);
      return { summary, byMonth, topSenders, byHour, byDow };
    },
    { query: listQuery }
  )
  .get("/messages-last-24h-by-list", (): Promise<ListMessagesLast24h[]> => analytics.getMessagesLast24hByList());
