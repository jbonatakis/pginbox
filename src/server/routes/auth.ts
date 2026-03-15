import type { Kysely } from "kysely";
import type {
  AuthForgotPasswordResponse,
  AuthLoginResponse,
  AuthMeResponse,
  AuthRegisterResponse,
  AuthResetPasswordResponse,
  AuthResendVerificationResponse,
  AuthVerifyEmailResponse,
} from "shared/api";
import { Elysia, t } from "elysia";
import {
  clearSessionCookie,
  getSessionRequestMetadata,
  normalizeEmail,
  resolveCurrentSession,
  setSessionCookie,
  type ResponseCookieTarget,
} from "../auth";
import { resolveAuthAppBaseUrl } from "../config";
import { assertSameOrigin, resolveConfiguredOrigin } from "./same-origin";
import {
  toAuthMeResponse,
  toAuthMessageResponse,
  toAuthUserResponse,
} from "../serialize";
import {
  authService as defaultAuthService,
  type AuthService,
} from "../services/auth.service";
import type { DB } from "../types/db.d.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const REGISTER_RESPONSE_MESSAGE =
  "If that email can be used, a verification email has been sent.";
const RESEND_VERIFICATION_RESPONSE_MESSAGE =
  "If the account is awaiting verification, a new email has been sent.";
const FORGOT_PASSWORD_RESPONSE_MESSAGE =
  "If the account exists, password reset instructions have been sent.";

const emailBodySchema = t.Object({
  email: t.String(),
});

const registerBodySchema = t.Object({
  email: t.String(),
  password: t.String(),
  displayName: t.Optional(t.Union([t.String(), t.Null()])),
});

const verifyEmailBodySchema = t.Object({
  token: t.String(),
});

const loginBodySchema = t.Object({
  email: t.String(),
  password: t.String(),
});

const resetPasswordBodySchema = t.Object({
  token: t.String(),
  newPassword: t.String(),
});

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export interface AuthRateLimitConfig {
  forgotPassword: { perEmail: RateLimitRule; perIp: RateLimitRule };
  login: { perEmail: RateLimitRule; perIp: RateLimitRule };
  register: { perEmail: RateLimitRule; perIp: RateLimitRule };
  resendVerification: { perEmail: RateLimitRule; perIp: RateLimitRule };
  resetPassword: { perEmail: RateLimitRule; perIp: RateLimitRule };
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimitConfig = {
  forgotPassword: {
    perEmail: { max: 5, windowMs: DAY_MS },
    perIp: { max: 5, windowMs: DAY_MS },
  },
  login: {
    perEmail: { max: 10, windowMs: 15 * MINUTE_MS },
    perIp: { max: 10, windowMs: 15 * MINUTE_MS },
  },
  register: {
    perEmail: { max: 5, windowMs: HOUR_MS },
    perIp: { max: 5, windowMs: HOUR_MS },
  },
  resendVerification: {
    perEmail: { max: 3, windowMs: HOUR_MS },
    perIp: { max: 3, windowMs: HOUR_MS },
  },
  resetPassword: {
    perEmail: { max: 5, windowMs: HOUR_MS },
    perIp: { max: 5, windowMs: HOUR_MS },
  },
};

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  readonly retryAfterSeconds: number;
  readonly status = 429;

  constructor(retryAfterMs: number) {
    super("Too many requests. Please try again later.");
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

export interface AuthRateLimiter {
  consume(key: string, rule: RateLimitRule, now?: Date): void;
}

class MemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  consume(key: string, rule: RateLimitRule, now = new Date()): void {
    const nowMs = now.getTime();
    const windowStart = nowMs - rule.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (recent.length >= rule.max) {
      throw new RateLimitError(recent[0] + rule.windowMs - nowMs);
    }

    recent.push(nowMs);
    this.attempts.set(key, recent);
  }
}

interface AuthRouteDependencies {
  appBaseUrl?: string;
  authService?: AuthService;
  db?: Kysely<DB>;
  now?: () => Date;
  rateLimiter?: AuthRateLimiter;
  rateLimits?: AuthRateLimitConfig;
}

interface RateLimitDescriptor {
  identifier: string;
  rule: RateLimitRule;
  scope: "email" | "ip";
}

function getRateLimitIpIdentifier(request: Request): string {
  const metadata = getSessionRequestMetadata(request);

  if (metadata.ipAddress) return metadata.ipAddress;

  try {
    return request.headers.get("origin")?.trim() || new URL(request.url).origin || "unknown";
  } catch {
    return request.headers.get("origin")?.trim() || "unknown";
  }
}

function consumeRateLimits(
  rateLimiter: AuthRateLimiter,
  route: keyof AuthRateLimitConfig,
  descriptors: RateLimitDescriptor[],
  now: Date
): void {
  for (const descriptor of descriptors) {
    rateLimiter.consume(
      `auth:${route}:${descriptor.scope}:${descriptor.identifier}`,
      descriptor.rule,
      now
    );
  }
}

export function createMemoryAuthRateLimiter(): AuthRateLimiter {
  return new MemoryAuthRateLimiter();
}

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

export function createAuthRoutes(dependencies: AuthRouteDependencies = {}) {
  const authService = dependencies.authService ?? defaultAuthService;
  const authDb = dependencies.db;
  const configuredOrigin = resolveConfiguredOrigin(
    dependencies.appBaseUrl ?? resolveAuthAppBaseUrl()
  );
  const now = dependencies.now ?? (() => new Date());
  const rateLimiter = dependencies.rateLimiter ?? createMemoryAuthRateLimiter();
  const rateLimits = dependencies.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS;

  return new Elysia({ prefix: "/auth" })
    .get("/me", async ({ request, set }): Promise<AuthMeResponse> => {
      const currentSession = await resolveCurrentSession({
        db: authDb,
        request,
        set: toResponseCookieTarget(set),
      });

      return toAuthMeResponse(currentSession.user);
    })
    .post(
      "/register",
      async ({ body, request, set }): Promise<AuthRegisterResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        consumeRateLimits(
          rateLimiter,
          "register",
          [
            {
              identifier: getRateLimitIpIdentifier(request),
              rule: rateLimits.register.perIp,
              scope: "ip",
            },
            {
              identifier: normalizeEmail(body.email),
              rule: rateLimits.register.perEmail,
              scope: "email",
            },
          ],
          currentTime
        );

        const result = await authService.register(body);
        set.status = 202;
        return toAuthMessageResponse(REGISTER_RESPONSE_MESSAGE, {
          developmentVerificationUrl: result.developmentVerificationUrl,
        }) as AuthRegisterResponse;
      },
      {
        body: registerBodySchema,
      }
    )
    .post(
      "/resend-verification",
      async ({ body, request, set }): Promise<AuthResendVerificationResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        consumeRateLimits(
          rateLimiter,
          "resendVerification",
          [
            {
              identifier: getRateLimitIpIdentifier(request),
              rule: rateLimits.resendVerification.perIp,
              scope: "ip",
            },
            {
              identifier: normalizeEmail(body.email),
              rule: rateLimits.resendVerification.perEmail,
              scope: "email",
            },
          ],
          currentTime
        );

        const result = await authService.resendVerification(body);
        set.status = 202;
        return toAuthMessageResponse(RESEND_VERIFICATION_RESPONSE_MESSAGE, {
          developmentVerificationUrl: result.developmentVerificationUrl,
        }) as AuthResendVerificationResponse;
      },
      {
        body: emailBodySchema,
      }
    )
    .post(
      "/verify-email",
      async ({ body, request, set }): Promise<AuthVerifyEmailResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        const result = await authService.verifyEmail(body, getSessionRequestMetadata(request));

        setSessionCookie(toResponseCookieTarget(set), result.sessionToken, { now: currentTime });
        return toAuthUserResponse(result.user);
      },
      {
        body: verifyEmailBodySchema,
      }
    )
    .post(
      "/login",
      async ({ body, request, set }): Promise<AuthLoginResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        consumeRateLimits(
          rateLimiter,
          "login",
          [
            {
              identifier: getRateLimitIpIdentifier(request),
              rule: rateLimits.login.perIp,
              scope: "ip",
            },
            {
              identifier: normalizeEmail(body.email),
              rule: rateLimits.login.perEmail,
              scope: "email",
            },
          ],
          currentTime
        );

        const result = await authService.login(body, getSessionRequestMetadata(request));

        setSessionCookie(toResponseCookieTarget(set), result.sessionToken, { now: currentTime });
        return toAuthUserResponse(result.user);
      },
      {
        body: loginBodySchema,
      }
    )
    .post("/logout", async ({ request, set }): Promise<void> => {
      assertSameOrigin(request, configuredOrigin);

      const currentSession = await resolveCurrentSession({
        db: authDb,
        request,
        set: toResponseCookieTarget(set),
      });

      if (currentSession.session) {
        await authService.logout(currentSession.session.id);
      }

      if (!currentSession.clearSessionCookie) {
        clearSessionCookie(toResponseCookieTarget(set));
      }

      set.status = 204;
    })
    .post(
      "/forgot-password",
      async ({ body, request, set }): Promise<AuthForgotPasswordResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        consumeRateLimits(
          rateLimiter,
          "forgotPassword",
          [
            {
              identifier: getRateLimitIpIdentifier(request),
              rule: rateLimits.forgotPassword.perIp,
              scope: "ip",
            },
            {
              identifier: normalizeEmail(body.email),
              rule: rateLimits.forgotPassword.perEmail,
              scope: "email",
            },
          ],
          currentTime
        );

        await authService.forgotPassword(body);
        set.status = 202;
        return toAuthMessageResponse(FORGOT_PASSWORD_RESPONSE_MESSAGE);
      },
      {
        body: emailBodySchema,
      }
    )
    .post(
      "/reset-password",
      async ({ body, request, set }): Promise<AuthResetPasswordResponse> => {
        assertSameOrigin(request, configuredOrigin);

        const currentTime = now();
        const descriptors: RateLimitDescriptor[] = [
          {
            identifier: getRateLimitIpIdentifier(request),
            rule: rateLimits.resetPassword.perIp,
            scope: "ip",
          },
        ];
        const emailLookup = await authService.lookupPasswordResetEmail(body.token);

        if (emailLookup?.email) {
          descriptors.push({
            identifier: normalizeEmail(emailLookup.email),
            rule: rateLimits.resetPassword.perEmail,
            scope: "email",
          });
        }

        consumeRateLimits(rateLimiter, "resetPassword", descriptors, currentTime);

        const result = await authService.resetPassword(body, getSessionRequestMetadata(request));

        setSessionCookie(toResponseCookieTarget(set), result.sessionToken, { now: currentTime });
        return toAuthUserResponse(result.user);
      },
      {
        body: resetPasswordBodySchema,
      }
    );
}

export const authRoutes = createAuthRoutes();

export type AuthRoutesPlugin = ReturnType<typeof createAuthRoutes>;
