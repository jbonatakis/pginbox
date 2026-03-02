import { Elysia } from "elysia";
import { getLists } from "../services/lists.service";

export const listsRoutes = new Elysia({ prefix: "/lists" }).get("/", () => getLists());
