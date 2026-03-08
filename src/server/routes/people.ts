import type { Paginated, Person, PersonListItem } from "shared/api";
import { Elysia, t } from "elysia";
import { toPerson } from "../serialize";
import { listPeople, getPerson } from "../services/people.service";

function parsePersonId(id: string): number | null {
  const n = Number(id);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseLimit(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

export const peopleRoutes = new Elysia({ prefix: "/people" })
  .get(
    "/",
    async ({ query, status }): Promise<Paginated<PersonListItem> | ReturnType<typeof status>> => {
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      return listPeople({ cursor: query.cursor, limit });
    },
    {
      query: t.Object({
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params, status }): Promise<Person | ReturnType<typeof status>> => {
      const id = parsePersonId(params.id);
      if (id === null) return status(400, { message: "Invalid person id" });
      const raw = await getPerson(id);
      if (!raw) return status(404, { message: "Person not found" });
      return toPerson(raw, raw.emails, raw.topThreads);
    },
    { params: t.Object({ id: t.String() }) }
  );
