import { Elysia, t } from "elysia";
import {
  requireAdminAuth,
  resolveCurrentSession,
  type ResponseCookieTarget,
} from "../auth";
import {
  disableAdminUser,
  enableAdminUser,
  getAdminStats,
  listAdminUsers,
  sendAdminPasswordReset,
  setAdminUserRole,
} from "../services/admin.service";

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

function parseLimit(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

export const adminRoutes = new Elysia({ prefix: "/admin" })
  .get(
    "/stats",
    async ({ request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      return getAdminStats();
    }
  )
  .get(
    "/users",
    async ({ query, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      return listAdminUsers({ q: query.q, cursor: query.cursor, limit });
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  )
  .post(
    "/users/:id/disable",
    async ({ body, params, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      return disableAdminUser(params.id, body.reason);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ reason: t.String() }),
    }
  )
  .post(
    "/users/:id/enable",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      return enableAdminUser(params.id);
    },
    { params: t.Object({ id: t.String() }) }
  )
  .post(
    "/users/:id/reset-password",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      await sendAdminPasswordReset(params.id);
      return { message: "Password reset email sent" };
    },
    { params: t.Object({ id: t.String() }) }
  )
  .patch(
    "/users/:id/role",
    async ({ body, params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      await requireAdminAuth(resolved);
      return setAdminUserRole(params.id, body.role);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ role: t.String() }),
    }
  );
