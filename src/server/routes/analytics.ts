import type { AnalyticsSummary, ByDow, ByHour, ByMonth, TopSender } from "shared/api";
import { Elysia } from "elysia";
import * as analytics from "../services/analytics.service";

export const analyticsRoutes = new Elysia({ prefix: "/analytics" })
  .get("/summary", (): Promise<AnalyticsSummary> => analytics.getSummary())
  .get("/by-month", (): Promise<ByMonth[]> => analytics.getByMonth())
  .get("/top-senders", (): Promise<TopSender[]> => analytics.getTopSenders())
  .get("/by-hour", (): Promise<ByHour[]> => analytics.getByHour())
  .get("/by-dow", (): Promise<ByDow[]> => analytics.getByDow());
