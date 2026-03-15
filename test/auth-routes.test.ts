import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../src/server/app";
import { db } from "../src/server/db";
import type {
  AuthEmailSender,
  PasswordResetEmailDelivery,
  VerificationEmailDelivery,
} from "../src/server/email";
import {
  DEFAULT_AUTH_RATE_LIMITS,
  createAuthRoutes,
  type AuthRateLimitConfig,
} from "../src/server/routes/auth";
import { createAuthService } from "../src/server/services/auth.service";

const apiBaseUrl = "http://localhost";
const frontendOrigin = "http://localhost:5173";
const validPassword = "correct horse battery staple";

class CapturingAuthMailer implements AuthEmailSender {
  readonly passwordResetUrls: string[] = [];
  readonly verificationUrls: string[] = [];

  async sendVerificationEmail(payload: VerificationEmailDelivery): Promise<void> {
    this.verificationUrls.push(payload.verificationUrl);
  }

  async sendPasswordResetEmail(payload: PasswordResetEmailDelivery): Promise<void> {
    this.passwordResetUrls.push(payload.resetUrl);
  }
}

function createTestApp(
  options: {
    emailMode?: "dev-auto-verify" | "log";
    rateLimits?: AuthRateLimitConfig;
  } = {}
) {
  const mailer = new CapturingAuthMailer();
  const authService = createAuthService({
    appBaseUrl: frontendOrigin,
    db,
    emailRuntimeConfig: { mode: options.emailMode ?? "log" },
    mailer,
  });
  const app = createApp({
    authRoutesPlugin: createAuthRoutes({
      appBaseUrl: frontendOrigin,
      authService,
      rateLimits: options.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
    }),
  });

  return { app, authService, mailer };
}

async function isAuthDbAvailable(): Promise<boolean> {
  try {
    await db.selectFrom("users").select("id").limit(1).execute();
    return true;
  } catch {
    return false;
  }
}

async function clearAuthTables(): Promise<void> {
  await db.deleteFrom("auth_sessions").execute();
  await db.deleteFrom("email_verification_tokens").execute();
  await db.deleteFrom("password_reset_tokens").execute();
  await db.deleteFrom("users").execute();
}

function extractToken(deliveryUrl: string): string {
  const token = new URL(deliveryUrl).searchParams.get("token");

  if (!token) {
    throw new Error(`Missing token in URL: ${deliveryUrl}`);
  }

  return token;
}

function sessionCookie(setCookie: string): string {
  return setCookie.split(";")[0] ?? setCookie;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

async function send(
  app: ReturnType<typeof createApp>,
  path: string,
  options: {
    body?: unknown;
    headers?: HeadersInit;
    method?: string;
  } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(options.body);
  }

  return app.handle(
    new Request(`${apiBaseUrl}${path}`, {
      body,
      headers,
      method: options.method ?? "GET",
    })
  );
}

async function registerPendingUser(
  app: ReturnType<typeof createApp>,
  mailer: CapturingAuthMailer,
  email: string
): Promise<string> {
  const response = await send(app, "/auth/register", {
    body: {
      email,
      password: validPassword,
    },
    headers: {
      origin: frontendOrigin,
    },
    method: "POST",
  });

  expect(response.status).toBe(202);
  expect(await parseJson(response)).toEqual({
    message: "If that email can be used, a verification email has been sent.",
  });

  const verificationUrl = mailer.verificationUrls.at(-1);
  expect(verificationUrl).toBeString();
  return extractToken(verificationUrl!);
}

async function verifyUser(
  app: ReturnType<typeof createApp>,
  token: string
): Promise<{ cookie: string; responseBody: unknown }> {
  const response = await send(app, "/auth/verify-email", {
    body: { token },
    headers: {
      origin: frontendOrigin,
    },
    method: "POST",
  });

  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("pginbox_session=");

  return {
    cookie: sessionCookie(setCookie!),
    responseBody: await parseJson(response),
  };
}

async function createActiveUser(
  app: ReturnType<typeof createApp>,
  mailer: CapturingAuthMailer,
  email: string
): Promise<{ cookie: string; token: string }> {
  const token = await registerPendingUser(app, mailer, email);
  const verification = await verifyUser(app, token);

  return {
    cookie: verification.cookie,
    token,
  };
}

const describeAuthRoutes = (await isAuthDbAvailable()) ? describe : describe.skip;

describe("auth routes without a database", () => {
  it("returns an anonymous me response when no session cookie is present", async () => {
    const { app } = createTestApp();
    const response = await send(app, "/auth/me");

    expect(response.status).toBe(200);
    expect(await parseJson(response)).toEqual({ user: null });
  });

  it("rejects cross-origin login attempts before auth state is mutated", async () => {
    const { app } = createTestApp();
    const response = await send(app, "/auth/login", {
      body: {
        email: "user@example.com",
        password: validPassword,
      },
      headers: {
        origin: "https://evil.example",
      },
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(await parseJson(response)).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Origin not allowed",
    });
  });
});

describeAuthRoutes("auth routes", () => {
  beforeEach(clearAuthTables);
  afterEach(clearAuthTables);

  it("returns a null user for stale sessions and clears the cookie", async () => {
    const { app } = createTestApp();

    const response = await send(app, "/auth/me", {
      headers: {
        cookie: "pginbox_session=stale-token",
      },
    });

    expect(response.status).toBe(200);
    expect(await parseJson(response)).toEqual({ user: null });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("supports register, verify, me, and logout while preserving public routes", async () => {
    const { app, mailer } = createTestApp();
    const email = "route-flow@example.com";

    const token = await registerPendingUser(app, mailer, email);

    const pendingUser = await db
      .selectFrom("users")
      .select(["email", "status"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    expect(pendingUser).toEqual({
      email,
      status: "pending_verification",
    });

    const verification = await verifyUser(app, token);
    expect(verification.responseBody).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });

    const meResponse = await send(app, "/auth/me", {
      headers: {
        cookie: verification.cookie,
      },
    });

    expect(meResponse.status).toBe(200);
    expect(await parseJson(meResponse)).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });

    const logoutResponse = await send(app, "/auth/logout", {
      headers: {
        cookie: verification.cookie,
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(logoutResponse.status).toBe(204);
    expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const staleSessionResponse = await send(app, "/auth/me", {
      headers: {
        cookie: verification.cookie,
      },
    });

    expect(staleSessionResponse.status).toBe(200);
    expect(await parseJson(staleSessionResponse)).toEqual({ user: null });
    expect(staleSessionResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const publicRouteResponse = await send(app, "/lists");
    expect(publicRouteResponse.status).toBe(200);
  });

  it("returns a development verification URL when auto-verify mode is enabled", async () => {
    const { app, mailer } = createTestApp({ emailMode: "dev-auto-verify" });
    const email = "dev-auto-verify@example.com";

    const response = await send(app, "/auth/register", {
      body: {
        email,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(response.status).toBe(202);
    const body = (await parseJson(response)) as {
      developmentVerificationUrl?: string;
      message: string;
    };

    expect(body.message).toBe("If that email can be used, a verification email has been sent.");
    expect(body.developmentVerificationUrl).toBeString();
    expect(new URL(body.developmentVerificationUrl!).origin).toBe(frontendOrigin);
    expect(new URL(body.developmentVerificationUrl!).pathname).toBe("/verify-email");
    expect(mailer.verificationUrls.at(-1)).toBe(body.developmentVerificationUrl);
  });

  it("returns generic resend responses and only sends mail for pending accounts", async () => {
    const { app, mailer } = createTestApp();
    const email = "pending@example.com";

    await registerPendingUser(app, mailer, email);
    mailer.verificationUrls.length = 0;

    const pendingResponse = await send(app, "/auth/resend-verification", {
      body: { email },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(pendingResponse.status).toBe(202);
    expect(await parseJson(pendingResponse)).toEqual({
      message: "If the account is awaiting verification, a new email has been sent.",
    });
    expect(mailer.verificationUrls).toHaveLength(1);

    await verifyUser(app, extractToken(mailer.verificationUrls[0]!));
    mailer.verificationUrls.length = 0;

    const activeResponse = await send(app, "/auth/resend-verification", {
      body: { email },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(activeResponse.status).toBe(202);
    expect(await parseJson(activeResponse)).toEqual({
      message: "If the account is awaiting verification, a new email has been sent.",
    });
    expect(mailer.verificationUrls).toHaveLength(0);
  });

  it("returns auth state errors on login and rejects cross-origin auth mutations", async () => {
    const { app, mailer } = createTestApp();
    const pendingEmail = "pending-login@example.com";

    await registerPendingUser(app, mailer, pendingEmail);

    const pendingLoginResponse = await send(app, "/auth/login", {
      body: {
        email: pendingEmail,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(pendingLoginResponse.status).toBe(403);
    expect(await parseJson(pendingLoginResponse)).toEqual({
      code: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });

    const activeEmail = "disabled-login@example.com";
    await createActiveUser(app, mailer, activeEmail);
    await db
      .updateTable("users")
      .set({
        disable_reason: "test",
        disabled_at: new Date(),
        status: "disabled",
      })
      .where("email", "=", activeEmail)
      .execute();

    const disabledLoginResponse = await send(app, "/auth/login", {
      body: {
        email: activeEmail,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(disabledLoginResponse.status).toBe(403);
    expect(await parseJson(disabledLoginResponse)).toEqual({
      code: "ACCOUNT_DISABLED",
      message: "This account is disabled",
    });

    const wrongOriginResponse = await send(app, "/auth/login", {
      body: {
        email: activeEmail,
        password: validPassword,
      },
      headers: {
        origin: "https://evil.example",
      },
      method: "POST",
    });

    expect(wrongOriginResponse.status).toBe(403);
    expect(await parseJson(wrongOriginResponse)).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Origin not allowed",
    });
  });

  it("keeps forgot/reset flows functional and revokes prior sessions", async () => {
    const { app, mailer } = createTestApp();
    const email = "reset-flow@example.com";
    const activeUser = await createActiveUser(app, mailer, email);

    const forgotPasswordResponse = await send(app, "/auth/forgot-password", {
      body: { email },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(forgotPasswordResponse.status).toBe(202);
    expect(await parseJson(forgotPasswordResponse)).toEqual({
      message: "If the account exists, password reset instructions have been sent.",
    });

    const resetPasswordToken = extractToken(mailer.passwordResetUrls.at(-1)!);
    const resetPasswordResponse = await send(app, "/auth/reset-password", {
      body: {
        newPassword: "an even more correct horse battery staple",
        token: resetPasswordToken,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(resetPasswordResponse.status).toBe(200);
    expect(await parseJson(resetPasswordResponse)).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });

    const staleSessionResponse = await send(app, "/auth/me", {
      headers: {
        cookie: activeUser.cookie,
      },
    });

    expect(staleSessionResponse.status).toBe(200);
    expect(await parseJson(staleSessionResponse)).toEqual({ user: null });
    expect(staleSessionResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const oldPasswordLogin = await send(app, "/auth/login", {
      body: {
        email,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(oldPasswordLogin.status).toBe(401);
    expect(await parseJson(oldPasswordLogin)).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    });
  });

  it("applies rate limits to register, resend, login, forgot-password, and reset-password", async () => {
    const tightRateLimits: AuthRateLimitConfig = {
      forgotPassword: {
        perEmail: { max: 1, windowMs: 60_000 },
        perIp: { max: 1, windowMs: 60_000 },
      },
      login: {
        perEmail: { max: 1, windowMs: 60_000 },
        perIp: { max: 1, windowMs: 60_000 },
      },
      register: {
        perEmail: { max: 1, windowMs: 60_000 },
        perIp: { max: 1, windowMs: 60_000 },
      },
      resendVerification: {
        perEmail: { max: 1, windowMs: 60_000 },
        perIp: { max: 1, windowMs: 60_000 },
      },
      resetPassword: {
        perEmail: { max: 1, windowMs: 60_000 },
        perIp: { max: 1, windowMs: 60_000 },
      },
    };
    const registerContext = createTestApp({
      rateLimits: tightRateLimits,
    });
    const registerEmail = "rate-register@example.com";

    await registerPendingUser(registerContext.app, registerContext.mailer, registerEmail);
    const secondRegisterResponse = await send(registerContext.app, "/auth/register", {
      body: {
        email: registerEmail,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(secondRegisterResponse.status).toBe(429);
    expect(await parseJson(secondRegisterResponse)).toEqual({
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again later.",
    });
    expect(secondRegisterResponse.headers.get("retry-after")).toBeString();

    const resendContext = createTestApp({
      rateLimits: tightRateLimits,
    });
    const resendEmail = "rate-resend@example.com";
    await registerPendingUser(resendContext.app, resendContext.mailer, resendEmail);
    const firstResendResponse = await send(resendContext.app, "/auth/resend-verification", {
      body: { email: resendEmail },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(firstResendResponse.status).toBe(202);

    const secondResendResponse = await send(resendContext.app, "/auth/resend-verification", {
      body: { email: resendEmail },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(secondResendResponse.status).toBe(429);

    const loginContext = createTestApp({
      rateLimits: tightRateLimits,
    });
    const loginEmail = "rate-login@example.com";
    await createActiveUser(loginContext.app, loginContext.mailer, loginEmail);
    const firstLoginResponse = await send(loginContext.app, "/auth/login", {
      body: {
        email: loginEmail,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(firstLoginResponse.status).toBe(200);

    const secondLoginResponse = await send(loginContext.app, "/auth/login", {
      body: {
        email: loginEmail,
        password: validPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(secondLoginResponse.status).toBe(429);

    const forgotContext = createTestApp({
      rateLimits: tightRateLimits,
    });
    const forgotEmail = "rate-forgot@example.com";
    await createActiveUser(forgotContext.app, forgotContext.mailer, forgotEmail);
    const firstForgotResponse = await send(forgotContext.app, "/auth/forgot-password", {
      body: { email: forgotEmail },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(firstForgotResponse.status).toBe(202);

    const secondForgotResponse = await send(forgotContext.app, "/auth/forgot-password", {
      body: { email: forgotEmail },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(secondForgotResponse.status).toBe(429);

    const resetContext = createTestApp({
      rateLimits: tightRateLimits,
    });
    const resetEmail = "rate-reset@example.com";
    await createActiveUser(resetContext.app, resetContext.mailer, resetEmail);
    const forgotForResetResponse = await send(resetContext.app, "/auth/forgot-password", {
      body: { email: resetEmail },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(forgotForResetResponse.status).toBe(202);

    const resetToken = extractToken(resetContext.mailer.passwordResetUrls.at(-1)!);
    const firstResetResponse = await send(resetContext.app, "/auth/reset-password", {
      body: {
        newPassword: "fresh reset password value",
        token: resetToken,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(firstResetResponse.status).toBe(200);

    const secondResetResponse = await send(resetContext.app, "/auth/reset-password", {
      body: {
        newPassword: "fresh reset password value",
        token: resetToken,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });
    expect(secondResetResponse.status).toBe(429);
  });
});
