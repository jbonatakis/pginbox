# pginbox API

Read-only REST API for the pginbox mailing-list archive. Built with **Elysia** (Bun), **Kysely** (Postgres), and shared types with the frontend.

## Layout

```
src/server/
├── app.ts          # Elysia app: onError, route mounting
├── index.ts        # Entrypoint: Bun.serve() wrapper around app.handle() with request logging
├── db.ts           # Kysely instance (DATABASE_URL)
├── errors.ts       # BadRequestError for 400 responses
├── serialize.ts    # DB shape → API shape (Date/bigint → string)
├── routes/         # Route handlers: validation, service call, serialize, return
├── services/       # Data access: Kysely queries, return raw DB rows
└── types/          # db.d.ts (Kysely codegen), not API contract types
```

API **contract** types live in **`shared/api.ts`** at repo root. Both backend and frontend import from there so the wire format stays in sync.

## Request flow

1. **Route** – Parse/validate params and query (return 400 if invalid).
2. **Service** – Run Kysely query, return raw rows (Date, bigint, etc.).
3. **Serialize** – Map to shared types (dates → ISO strings, bigint → string).
4. **Return** – Handler return type is the shared type; Elysia sends JSON.

Validation and not-found live in the route layer; business logic and SQL live in services; wire shape is defined in `shared/api.ts` and enforced in `serialize.ts`.

## Adding a new endpoint

Example: **GET /people/:id/threads** – paginated list of threads a person participated in.

### 1. Define the contract in `shared/api.ts`

```ts
// e.g. next to Person, PersonListItem

export interface PersonThreadSummary {
  thread_id: string;
  subject: string | null;
  last_activity_at: string | null;
  message_count: number;
}

// Response is Paginated<PersonThreadSummary> — already have Paginated<T>.
```

### 2. Implement the service

In `services/people.service.ts` (or the right service), add a function that returns **raw** DB rows (no date/bigint conversion here):

```ts
export async function getPersonThreads(
  personId: number,
  query: { cursor?: string; limit: number }
) {
  const limit = Math.min(Math.max(1, query.limit), 100);
  // Build query: e.g. messages JOIN threads JOIN people_emails
  // WHERE people_emails.person_id = personId, cursor pagination
  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items[items.length - 1]
    ? encodeCursor(/* ... */)
    : null;
  return { items, nextCursor };
}
```

### 3. Add serialization (if the response has Date or bigint)

In `serialize.ts`, add a mapper so the wire format matches the shared type:

```ts
export function toPersonThreadSummary(row: {
  thread_id: string;
  subject: string | null;
  last_activity_at: Date | null;
  message_count: number;
}): PersonThreadSummary {
  return {
    thread_id: row.thread_id,
    subject: row.subject,
    last_activity_at: dateToIso(row.last_activity_at),
    message_count: row.message_count,
  };
}
```

If the response is only numbers and strings, you can skip this and return the service result directly.

### 4. Wire the route

In `routes/people.ts` (or the appropriate file), add the handler. Validate input, call the service, serialize, and type the return as the shared type:

```ts
import type { Paginated, PersonThreadSummary } from "shared/api";
import { toPersonThreadSummary } from "../serialize";
import { getPersonThreads } from "../services/people.service";

// Add to the existing Elysia chain:
.get(
  "/:id/threads",
  async ({ params, query, status }): Promise<Paginated<PersonThreadSummary> | ReturnType<typeof status>> => {
    const id = parsePersonId(params.id);
    if (id === null) return status(400, { message: "Invalid person id" });
    const limit = parseLimit(query.limit, 25);
    if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });

    const raw = await getPersonThreads(id, { cursor: query.cursor, limit });
    return {
      items: raw.items.map(toPersonThreadSummary),
      nextCursor: raw.nextCursor,
    };
  },
  {
    query: t.Object({ cursor: t.Optional(t.String()), limit: t.Optional(t.String()) }),
    params: t.Object({ id: t.String() }),
  }
)
```

### 5. (Optional) Add a test

In `test/api.test.ts`, add a test that hits the new URL and asserts status and response shape (e.g. `items`, `nextCursor`).

---

**Checklist:** shared type → service (raw) → serialize (if needed) → route (validate, call, serialize, return) → test.

## Running

- **Start API:** `make api` or `bun src/server/index.ts` (expects Postgres on `DATABASE_URL`, default port 5499).
- **Tests:** `make test` – uses `app.handle()` in-process (no server); requires DB for list/detail/analytics tests.
