import { Elysia } from "elysia";
import * as analytics from "../services/analytics.service";

export const analyticsRoutes = new Elysia({ prefix: "/analytics" })
  .get("/summary", () => analytics.getSummary())
  .get("/by-month", () => analytics.getByMonth())
  .get("/top-senders", () => analytics.getTopSenders())
  .get("/by-hour", () => analytics.getByHour())
  .get("/by-dow", () => analytics.getByDow());
