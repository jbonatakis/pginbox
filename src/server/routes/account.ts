import type { Kysely } from "kysely";
import type {
  AccountProfileUpdateResponse,
  AddEmailResponse,
  RemoveEmailResponse,
  ResendEmailVerificationResponse,
  SetPrimaryEmailResponse,
  UserEmailsResponse,
} from "shared/api";
import { Elysia, t } from "elysia";
import {
  requireAuth,
  resolveCurrentSession,
  type ResponseCookieTarget,
} from "../auth";
import { resolveAuthAppBaseUrl } from "../config";
import { toAuthUserResponse, toUserEmailsResponse } from "../serialize";
import {
  authService as defaultAuthService,
  type AuthService,
} from "../services/auth.service";
import type { DB } from "../types/db.d.ts";
import { assertSameOrigin, resolveConfiguredOrigin } from "./same-origin";

const profileBodySchema = t.Object({
  displayName: t.Union([t.String(), t.Null()]),
});

const addEmailBodySchema = t.Object({
  email: t.String(),
});

const emailIdParamsSchema = t.Object({
  id: t.String(),
});

interface AccountRouteDependencies {
  appBaseUrl?: string;
  authService?: AuthService;
  db?: Kysely<DB>;
}

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

const ADD_EMAIL_RESPONSE_MESSAGE =
  "If that email can be used, a verification email has been sent.";
const RESEND_EMAIL_VERIFICATION_MESSAGE =
  "If the email is pending verification, a new email has been sent.";

export function createAccountRoutes(dependencies: AccountRouteDependencies = {}) {
  const authService = dependencies.authService ?? defaultAuthService;
  const accountDb = dependencies.db;
  const configuredOrigin = resolveConfiguredOrigin(
    dependencies.appBaseUrl ?? resolveAuthAppBaseUrl()
  );

  return new Elysia({ prefix: "/account" })
    .patch(
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
    )
    .get(
      "/emails",
      async ({ request, set }): Promise<UserEmailsResponse> => {
        const resolved = await resolveCurrentSession({
          db: accountDb,
          request,
          set: toResponseCookieTarget(set),
        });
        const currentSession = await requireAuth(resolved);
        const emails = await authService.listEmails(currentSession.user.id);

        return toUserEmailsResponse(emails);
      }
    )
    .post(
      "/emails",
      async ({ body, request, set }): Promise<AddEmailResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const resolved = await resolveCurrentSession({
          db: accountDb,
          request,
          set: toResponseCookieTarget(set),
        });
        const currentSession = await requireAuth(resolved);
        const result = await authService.addEmail(currentSession.user.id, body.email);

        set.status = 202;
        return {
          message: ADD_EMAIL_RESPONSE_MESSAGE,
          ...(result.developmentVerificationUrl
            ? { developmentVerificationUrl: result.developmentVerificationUrl }
            : {}),
        };
      },
      {
        body: addEmailBodySchema,
      }
    )
    .post(
      "/emails/:id/make-primary",
      async ({ params, request, set }): Promise<SetPrimaryEmailResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const resolved = await resolveCurrentSession({
          db: accountDb,
          request,
          set: toResponseCookieTarget(set),
        });
        const currentSession = await requireAuth(resolved);
        await authService.setPrimaryEmail(currentSession.user.id, params.id);
        const emails = await authService.listEmails(currentSession.user.id);

        return toUserEmailsResponse(emails);
      },
      {
        params: emailIdParamsSchema,
      }
    )
    .delete(
      "/emails/:id",
      async ({ params, request, set }): Promise<RemoveEmailResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const resolved = await resolveCurrentSession({
          db: accountDb,
          request,
          set: toResponseCookieTarget(set),
        });
        const currentSession = await requireAuth(resolved);
        await authService.removeEmail(currentSession.user.id, params.id);
        const emails = await authService.listEmails(currentSession.user.id);

        return toUserEmailsResponse(emails);
      },
      {
        params: emailIdParamsSchema,
      }
    )
    .post(
      "/emails/:id/resend-verification",
      async ({ params, request, set }): Promise<ResendEmailVerificationResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const resolved = await resolveCurrentSession({
          db: accountDb,
          request,
          set: toResponseCookieTarget(set),
        });
        const currentSession = await requireAuth(resolved);
        const result = await authService.resendVerificationForEmail(
          currentSession.user.id,
          params.id
        );

        set.status = 202;
        return {
          message: RESEND_EMAIL_VERIFICATION_MESSAGE,
          ...(result.developmentVerificationUrl
            ? { developmentVerificationUrl: result.developmentVerificationUrl }
            : {}),
        };
      },
      {
        params: emailIdParamsSchema,
      }
    );
}

export const accountRoutes = createAccountRoutes();

export type AccountRoutesPlugin = ReturnType<typeof createAccountRoutes>;
