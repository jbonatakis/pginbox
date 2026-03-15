import type { Kysely } from "kysely";
import type { AccountProfileUpdateResponse } from "shared/api";
import { Elysia, t } from "elysia";
import {
  requireAuth,
  resolveCurrentSession,
  type ResponseCookieTarget,
} from "../auth";
import { resolveAuthAppBaseUrl } from "../config";
import { toAuthUserResponse } from "../serialize";
import {
  authService as defaultAuthService,
  type AuthService,
} from "../services/auth.service";
import type { DB } from "../types/db.d.ts";
import { assertSameOrigin, resolveConfiguredOrigin } from "./same-origin";

const profileBodySchema = t.Object({
  displayName: t.Union([t.String(), t.Null()]),
});

interface AccountRouteDependencies {
  appBaseUrl?: string;
  authService?: AuthService;
  db?: Kysely<DB>;
}

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

export function createAccountRoutes(dependencies: AccountRouteDependencies = {}) {
  const authService = dependencies.authService ?? defaultAuthService;
  const accountDb = dependencies.db;
  const configuredOrigin = resolveConfiguredOrigin(
    dependencies.appBaseUrl ?? resolveAuthAppBaseUrl()
  );

  return new Elysia({ prefix: "/account" }).patch(
    "/profile",
    async ({ body, request, set }): Promise<AccountProfileUpdateResponse> => {
      assertSameOrigin(request, configuredOrigin);

      const resolved = await resolveCurrentSession({
        db: accountDb,
        request,
        set: toResponseCookieTarget(set),
      });
      const currentSession = await requireAuth(resolved);
      const user = await authService.updateProfile(currentSession.user.id, body);

      return toAuthUserResponse(user);
    },
    {
      body: profileBodySchema,
    }
  );
}

export const accountRoutes = createAccountRoutes();

export type AccountRoutesPlugin = ReturnType<typeof createAccountRoutes>;
