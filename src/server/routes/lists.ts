import type { List } from "shared/api";
import { Elysia } from "elysia";
import { toList } from "../serialize";
import { getLists } from "../services/lists.service";

export const listsRoutes = new Elysia({ prefix: "/lists" }).get("/", async (): Promise<List[]> => {
  const rows = await getLists();
  return rows.map(toList);
});
