import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../../src/server/app";
import type {
  AuthEmailSender,
  PasswordResetEmailDelivery,
  VerificationEmailDelivery,
} from "../../src/server/email";
import { createAccountRoutes } from "../../src/server/routes/account";
import {
  DEFAULT_AUTH_RATE_LIMITS,
  createAuthRoutes,
  type AuthRateLimitConfig,
} from "../../src/server/routes/auth";
import { createAuthService } from "../../src/server/services/auth.service";
import { getTestDatabaseContext } from "./test-db";

const apiBaseUrl = "http://localhost";
const frontendOrigin = "http://localhost:5173";
const validPassword = "correct horse battery staple";
const testDatabaseContext = getTestDatabaseContext();

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
    useTestDb?: boolean;
  } = {}
) {
  const authDb = options.useTestDb === false ? undefined : getAuthDb();
  const mailer = new CapturingAuthMailer();
  const authService = createAuthService({
    appBaseUrl: frontendOrigin,
    db: authDb,
    emailRuntimeConfig: { mode: options.emailMode ?? "log" },
    mailer,
  });
  const app = createApp({
    accountRoutesPlugin: createAccountRoutes({
      appBaseUrl: frontendOrigin,
      authService,
      db: authDb,
    }),
    authRoutesPlugin: createAuthRoutes({
      appBaseUrl: frontendOrigin,
      authService,
      db: authDb,
      rateLimits: options.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
    }),
  });

  return { app, authService, mailer };
}

function getAuthDb() {
  if (!testDatabaseContext) {
    throw new Error("TEST_DATABASE_URL is not configured for auth DB tests");
  }

  return testDatabaseContext.db;
}

async function isAuthDbAvailable(): Promise<boolean> {
  if (!testDatabaseContext) {
    return false;
  }

  try {
    await getAuthDb().selectFrom("users").select("id").limit(1).execute();
    return true;
  } catch (error) {
    throw new Error(
      `TEST_DATABASE_URL is configured but auth tables are unavailable in ${testDatabaseContext.databaseName}. Run make migrate-test.`,
      { cause: error }
    );
  }
}

async function clearAuthTables(): Promise<void> {
  const authDb = getAuthDb();
  await authDb.deleteFrom("auth_sessions").execute();
  await authDb.deleteFrom("email_verification_tokens").execute();
  await authDb.deleteFrom("password_reset_tokens").execute();
  await authDb.deleteFrom("users").execute();
}

async function getUserIdByEmail(email: string): Promise<bigint> {
  const row = await getAuthDb()
    .selectFrom("user_emails")
    .select("user_id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return row.user_id as bigint;
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
    const { app } = createTestApp({ useTestDb: false });
    const response = await send(app, "/auth/me");

    expect(response.status).toBe(200);
    expect(await parseJson(response)).toEqual({ user: null });
  });

  it("rejects cross-origin login attempts before auth state is mutated", async () => {
    const { app } = createTestApp({ useTestDb: false });
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

    const pendingUser = await getAuthDb()
      .selectFrom("users")
      .innerJoin("user_email_claims", "user_email_claims.user_id", "users.id")
      .select(["user_email_claims.email", "users.status"])
      .where("user_email_claims.email", "=", email)
      .where("user_email_claims.claim_kind", "=", "registration")
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
    const activeEmailUserId = await getUserIdByEmail(activeEmail);
    await getAuthDb()
      .updateTable("users")
      .set({
        disable_reason: "test",
        disabled_at: new Date(),
        status: "disabled",
      })
      .where("id", "=", activeEmailUserId)
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

  it("updates the authenticated user's display name through the account profile route", async () => {
    const { app, mailer } = createTestApp();
    const email = "profile-update@example.com";
    const activeUser = await createActiveUser(app, mailer, email);
    const beforeUpdate = await getAuthDb()
      .selectFrom("users")
      .innerJoin("user_emails", "user_emails.user_id", "users.id")
      .select(["users.display_name", "users.updated_at"])
      .where("user_emails.email", "=", email)
      .executeTakeFirstOrThrow();

    const updateResponse = await send(app, "/account/profile", {
      body: {
        displayName: "Updated Account Name",
      },
      headers: {
        cookie: activeUser.cookie,
        origin: frontendOrigin,
      },
      method: "PATCH",
    });

    expect(updateResponse.status).toBe(200);
    expect(await parseJson(updateResponse)).toMatchObject({
      user: {
        displayName: "Updated Account Name",
        email,
      },
    });

    const userRow = await getAuthDb()
      .selectFrom("users")
      .innerJoin("user_emails", "user_emails.user_id", "users.id")
      .select(["user_emails.email", "users.display_name", "users.updated_at"])
      .where("user_emails.email", "=", email)
      .executeTakeFirstOrThrow();
    const timestampCheck = await getAuthDb()
      .selectFrom("users")
      .innerJoin("user_emails", "user_emails.user_id", "users.id")
      .select(sql<boolean>`users.updated_at > ${beforeUpdate.updated_at}`.as("updated_after_previous"))
      .where("user_emails.email", "=", email)
      .executeTakeFirstOrThrow();

    expect(userRow.email).toBe(email);
    expect(userRow.display_name).toBe("Updated Account Name");
    expect(timestampCheck.updated_after_previous).toBe(true);

    const meResponse = await send(app, "/auth/me", {
      headers: {
        cookie: activeUser.cookie,
      },
    });

    expect(meResponse.status).toBe(200);
    expect(await parseJson(meResponse)).toMatchObject({
      user: {
        displayName: "Updated Account Name",
        email,
      },
    });
  });

  it("requires auth and same-origin requests for account profile updates", async () => {
    const { app, mailer } = createTestApp();
    const email = "profile-guard@example.com";
    const activeUser = await createActiveUser(app, mailer, email);

    const unauthenticatedResponse = await send(app, "/account/profile", {
      body: {
        displayName: "Nope",
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "PATCH",
    });

    expect(unauthenticatedResponse.status).toBe(401);
    expect(await parseJson(unauthenticatedResponse)).toEqual({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
    });

    const wrongOriginResponse = await send(app, "/account/profile", {
      body: {
        displayName: "Nope",
      },
      headers: {
        cookie: activeUser.cookie,
        origin: "https://evil.example",
      },
      method: "PATCH",
    });

    expect(wrongOriginResponse.status).toBe(403);
    expect(await parseJson(wrongOriginResponse)).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Origin not allowed",
    });
  });

  it("manages secondary email claims and verified secondary emails through account routes", async () => {
    const { app, mailer } = createTestApp();
    const primaryEmail = "account-primary@example.com";
    const secondaryEmail = "account-secondary@example.com";
    const activeUser = await createActiveUser(app, mailer, primaryEmail);

    mailer.verificationUrls.length = 0;

    const addEmailResponse = await send(app, "/account/emails", {
      body: { email: secondaryEmail },
      headers: {
        cookie: activeUser.cookie,
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(addEmailResponse.status).toBe(202);
    expect(await parseJson(addEmailResponse)).toEqual({
      message: "Request submitted.",
    });
    expect(mailer.verificationUrls).toHaveLength(1);

    const pendingEmailsResponse = await send(app, "/account/emails", {
      headers: {
        cookie: activeUser.cookie,
      },
    });

    expect(pendingEmailsResponse.status).toBe(200);
    const pendingEmailsBody = await parseJson(pendingEmailsResponse) as {
      emails: Array<{
        createdAt: string;
        email: string;
        id: string;
        isPrimary: boolean;
        verifiedAt: string | null;
      }>;
    };
    const pendingPrimaryEmail = pendingEmailsBody.emails.find((entry) => entry.email === primaryEmail);
    const pendingSecondaryEmail = pendingEmailsBody.emails.find((entry) => entry.email === secondaryEmail);

    expect(pendingPrimaryEmail).toMatchObject({
      email: primaryEmail,
      isPrimary: true,
    });
    expect(pendingPrimaryEmail?.id).toStartWith("email:");
    expect(pendingSecondaryEmail).toMatchObject({
      email: secondaryEmail,
      isPrimary: false,
      verifiedAt: null,
    });
    expect(pendingSecondaryEmail?.id).toStartWith("claim:");

    mailer.verificationUrls.length = 0;

    const resendSecondaryResponse = await send(
      app,
      `/account/emails/${encodeURIComponent(pendingSecondaryEmail!.id)}/resend-verification`,
      {
        headers: {
          cookie: activeUser.cookie,
          origin: frontendOrigin,
        },
        method: "POST",
      }
    );

    expect(resendSecondaryResponse.status).toBe(202);
    expect(await parseJson(resendSecondaryResponse)).toEqual({
      message: "If the email is pending verification, a new email has been sent.",
    });
    expect(mailer.verificationUrls).toHaveLength(1);

    const verifySecondaryResponse = await send(app, "/auth/verify-email", {
      body: {
        token: extractToken(mailer.verificationUrls[0]!),
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(verifySecondaryResponse.status).toBe(200);
    expect(await parseJson(verifySecondaryResponse)).toMatchObject({
      isRegistration: false,
      user: {
        email: primaryEmail,
        status: "active",
      },
    });
    expect(verifySecondaryResponse.headers.get("set-cookie")).toBeNull();

    const verifiedEmailsResponse = await send(app, "/account/emails", {
      headers: {
        cookie: activeUser.cookie,
      },
    });

    expect(verifiedEmailsResponse.status).toBe(200);
    const verifiedEmailsBody = await parseJson(verifiedEmailsResponse) as {
      emails: Array<{
        createdAt: string;
        email: string;
        id: string;
        isPrimary: boolean;
        verifiedAt: string | null;
      }>;
    };
    const verifiedSecondaryEmail = verifiedEmailsBody.emails.find((entry) => entry.email === secondaryEmail);

    expect(verifiedSecondaryEmail).toMatchObject({
      email: secondaryEmail,
      isPrimary: false,
    });
    expect(verifiedSecondaryEmail?.id).toStartWith("email:");
    expect(verifiedSecondaryEmail?.verifiedAt).toBeString();

    const makePrimaryResponse = await send(
      app,
      `/account/emails/${encodeURIComponent(verifiedSecondaryEmail!.id)}/make-primary`,
      {
        headers: {
          cookie: activeUser.cookie,
          origin: frontendOrigin,
        },
        method: "POST",
      }
    );

    expect(makePrimaryResponse.status).toBe(200);
    const makePrimaryBody = await parseJson(makePrimaryResponse) as {
      emails: Array<{
        createdAt: string;
        email: string;
        id: string;
        isPrimary: boolean;
        verifiedAt: string | null;
      }>;
    };
    const updatedPrimaryEmail = makePrimaryBody.emails.find((entry) => entry.email === secondaryEmail);
    const demotedPrimaryEmail = makePrimaryBody.emails.find((entry) => entry.email === primaryEmail);

    expect(updatedPrimaryEmail?.isPrimary).toBe(true);
    expect(demotedPrimaryEmail?.isPrimary).toBe(false);

    const removeOriginalPrimaryResponse = await send(
      app,
      `/account/emails/${encodeURIComponent(demotedPrimaryEmail!.id)}`,
      {
        headers: {
          cookie: activeUser.cookie,
          origin: frontendOrigin,
        },
        method: "DELETE",
      }
    );

    expect(removeOriginalPrimaryResponse.status).toBe(200);
    expect(await parseJson(removeOriginalPrimaryResponse)).toEqual({
      emails: [
        expect.objectContaining({
          email: secondaryEmail,
          isPrimary: true,
        }),
      ],
    });
  });

  it("does not let unverified secondary claims squat a registration email", async () => {
    const { app, mailer } = createTestApp();
    const squatterEmail = "squatter@example.com";
    const claimedEmail = "tom.lane@example.com";
    const squatter = await createActiveUser(app, mailer, squatterEmail);

    mailer.verificationUrls.length = 0;

    const addClaimResponse = await send(app, "/account/emails", {
      body: { email: claimedEmail },
      headers: {
        cookie: squatter.cookie,
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(addClaimResponse.status).toBe(202);
    expect(await parseJson(addClaimResponse)).toEqual({
      message: "Request submitted.",
    });

    const squatterClaimToken = extractToken(mailer.verificationUrls.at(-1)!);
    const squatterEmailsBeforeResponse = await send(app, "/account/emails", {
      headers: {
        cookie: squatter.cookie,
      },
    });

    expect(squatterEmailsBeforeResponse.status).toBe(200);
    const squatterEmailsBefore = await parseJson(squatterEmailsBeforeResponse) as {
      emails: Array<{
        createdAt: string;
        email: string;
        id: string;
        isPrimary: boolean;
        verifiedAt: string | null;
      }>;
    };
    const squattedClaim = squatterEmailsBefore.emails.find((entry) => entry.email === claimedEmail);

    expect(squattedClaim).toMatchObject({
      email: claimedEmail,
      isPrimary: false,
      verifiedAt: null,
    });
    expect(squattedClaim?.id).toStartWith("claim:");

    mailer.verificationUrls.length = 0;
    const ownerRegistrationToken = await registerPendingUser(app, mailer, claimedEmail);
    await verifyUser(app, ownerRegistrationToken);

    const squatterEmailsAfterResponse = await send(app, "/account/emails", {
      headers: {
        cookie: squatter.cookie,
      },
    });

    expect(squatterEmailsAfterResponse.status).toBe(200);
    const squatterEmailsAfter = await parseJson(squatterEmailsAfterResponse) as {
      emails: Array<{ email: string }>;
    };
    expect(squatterEmailsAfter.emails.some((entry) => entry.email === claimedEmail)).toBe(false);

    const staleSquatterVerification = await send(app, "/auth/verify-email", {
      body: { token: squatterClaimToken },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(staleSquatterVerification.status).toBe(400);
    expect(await parseJson(staleSquatterVerification)).toEqual({
      code: "TOKEN_INVALID",
      message: "The token is invalid",
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
