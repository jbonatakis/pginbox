import { Elysia, t } from "elysia";
import { listPeople, getPerson } from "../services/people.service";

export const peopleRoutes = new Elysia({ prefix: "/people" })
  .get(
    "/",
    ({ query }) => listPeople(query),
    {
      query: t.Object({
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params, error }) => {
      const person = await getPerson(Number(params.id));
      return person ?? error(404, { message: "Person not found" });
    },
    { params: t.Object({ id: t.String() }) }
  );
