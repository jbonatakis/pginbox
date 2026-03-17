import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import {
  SESSION_TTL_MS,
  hashOpaqueToken,
  verifyPassword,
} from "../../src/server/auth";
import {
  createDevelopmentAuthEmailSender,
  type AuthEmailSender,
  type PasswordResetEmailDelivery,
  type VerificationEmailDelivery,
} from "../../src/server/email";
import { createAuthRoutes } from "../../src/server/routes/auth";
import { createAuthService } from "../../src/server/services/auth.service";
import { getTestDatabaseContext } from "./test-db";

const apiBaseUrl = "http://localhost";
const frontendOrigin = "http://localhost:5173";
const initialPassword = "correct horse battery staple";
const replacementPassword = "an even better battery staple";
const resetPasswordValue = "reset to another long passphrase";
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

class CapturingLogger {
  readonly messages: string[] = [];

  info(message?: unknown, ...optionalParams: unknown[]): void {
    const rendered = [message, ...optionalParams]
      .filter((value) => value !== undefined)
      .map((value) => String(value))
      .join(" ");

    this.messages.push(rendered);
  }
}

function createTestApp(options: {
  mailer?: AuthEmailSender;
  now?: () => Date;
} = {}) {
  const authDb = getAuthDb();
  const authService = createAuthService({
    appBaseUrl: frontendOrigin,
    db: authDb,
    mailer: options.mailer,
    now: options.now,
  });

  return createApp({
    authRoutesPlugin: createAuthRoutes({
      appBaseUrl: frontendOrigin,
      authService,
      db: authDb,
      now: options.now,
    }),
  });
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

async function withNodeEnv<T>(
  value: string | undefined,
  callback: () => Promise<T> | T
): Promise<T> {
  const previous = process.env.NODE_ENV;

  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

function extractToken(deliveryUrl: string): string {
  const token = new URL(deliveryUrl).searchParams.get("token");

  if (!token) {
    throw new Error(`Missing token in URL: ${deliveryUrl}`);
  }

  return token;
}

function extractLastLoggedUrl(logger: CapturingLogger, marker: string): string {
  const line = [...logger.messages].reverse().find((entry) => entry.includes(marker));

  if (!line) {
    throw new Error(`Missing log line for marker: ${marker}`);
  }

  const match = line.match(/https?:\/\/\S+/);

  if (!match) {
    throw new Error(`Missing URL in log line: ${line}`);
  }

  return match[0];
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
  input: {
    displayName?: string | null;
    email: string;
    password?: string;
  }
): Promise<string> {
  const response = await send(app, "/auth/register", {
    body: {
      displayName: input.displayName,
      email: input.email,
      password: input.password ?? initialPassword,
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
): Promise<{ cookie: string; responseBody: unknown; setCookie: string }> {
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
    setCookie: setCookie!,
  };
}

async function createActiveUser(
  app: ReturnType<typeof createApp>,
  mailer: CapturingAuthMailer,
  email: string,
  password = initialPassword
): Promise<{ cookie: string; token: string }> {
  const token = await registerPendingUser(app, mailer, { email, password });
  const verification = await verifyUser(app, token);

  return {
    cookie: verification.cookie,
    token,
  };
}

async function insertSessionForUser(
  userId: bigint | number | string,
  token: string
): Promise<void> {
  const now = new Date();
  const createdAt = new Date(now.getTime() - 60_000);

  await getAuthDb()
    .insertInto("auth_sessions")
    .values({
      created_at: createdAt,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      last_seen_at: createdAt,
      token_hash: hashOpaqueToken(token),
      user_id: userId,
    })
    .execute();
}

const describeAuth = (await isAuthDbAvailable()) ? describe : describe.skip;

describeAuth("auth lifecycle coverage", () => {
  beforeEach(clearAuthTables);
  afterEach(clearAuthTables);

  it("registers new users, replaces pending credentials, and rotates verification tokens", async () => {
    const mailer = new CapturingAuthMailer();
    const app = createTestApp({ mailer });
    const email = "pending-update@example.com";

    const firstToken = await registerPendingUser(app, mailer, {
      displayName: "First Pending",
      email,
      password: initialPassword,
    });

    const firstUser = await getAuthDb()
      .selectFrom("users")
      .select(["id", "display_name", "password_hash", "status"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    expect(firstUser.display_name).toBe("First Pending");
    expect(firstUser.status).toBe("pending_verification");
    expect(await verifyPassword(initialPassword, firstUser.password_hash)).toBe(true);

    const firstTokenRow = await getAuthDb()
      .selectFrom("email_verification_tokens")
      .select(["token_hash", "consumed_at"])
      .where("user_id", "=", firstUser.id)
      .where("token_hash", "=", hashOpaqueToken(firstToken))
      .executeTakeFirstOrThrow();

    expect(firstTokenRow.consumed_at).toBeNull();

    const secondRegisterResponse = await send(app, "/auth/register", {
      body: {
        displayName: "Updated Pending",
        email,
        password: replacementPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(secondRegisterResponse.status).toBe(202);
    expect(await parseJson(secondRegisterResponse)).toEqual({
      message: "If that email can be used, a verification email has been sent.",
    });

    const secondToken = extractToken(mailer.verificationUrls.at(-1)!);
    expect(secondToken).not.toBe(firstToken);

    const updatedUser = await getAuthDb()
      .selectFrom("users")
      .select(["id", "display_name", "password_hash", "status"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    expect(updatedUser.id).toBe(firstUser.id);
    expect(updatedUser.display_name).toBe("Updated Pending");
    expect(updatedUser.status).toBe("pending_verification");
    expect(await verifyPassword(initialPassword, updatedUser.password_hash)).toBe(false);
    expect(await verifyPassword(replacementPassword, updatedUser.password_hash)).toBe(true);

    const tokenRows = await getAuthDb()
      .selectFrom("email_verification_tokens")
      .select(["token_hash", "consumed_at"])
      .where("user_id", "=", firstUser.id)
      .orderBy("created_at", "asc")
      .execute();

    expect(tokenRows).toHaveLength(2);
    expect(tokenRows[0]?.token_hash).toBe(hashOpaqueToken(firstToken));
    expect(tokenRows[0]?.consumed_at).not.toBeNull();
    expect(tokenRows[1]?.token_hash).toBe(hashOpaqueToken(secondToken));
    expect(tokenRows[1]?.consumed_at).toBeNull();

    const staleVerificationResponse = await send(app, "/auth/verify-email", {
      body: { token: firstToken },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(staleVerificationResponse.status).toBe(400);
    expect(await parseJson(staleVerificationResponse)).toEqual({
      code: "TOKEN_INVALID",
      message: "The token is invalid",
    });

    const verification = await verifyUser(app, secondToken);
    expect(verification.responseBody).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });
  });

  it("drives verification and reset flows from development mail stub output", async () => {
    const logger = new CapturingLogger();
    const app = createTestApp({
      mailer: createDevelopmentAuthEmailSender(logger),
    });
    const email = "dev-mail-flow@example.com";

    const registerResponse = await send(app, "/auth/register", {
      body: {
        email,
        password: initialPassword,
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(registerResponse.status).toBe(202);

    const verificationUrl = extractLastLoggedUrl(logger, "[auth:dev-mail] verification email");
    expect(new URL(verificationUrl).pathname).toBe("/verify-email");

    const verifyResponse = await send(app, "/auth/verify-email", {
      body: {
        token: extractToken(verificationUrl),
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(verifyResponse.status).toBe(200);
    expect(await parseJson(verifyResponse)).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });

    const forgotResponse = await send(app, "/auth/forgot-password", {
      body: { email },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(forgotResponse.status).toBe(202);

    const resetUrl = extractLastLoggedUrl(logger, "[auth:dev-mail] password reset email");
    expect(new URL(resetUrl).pathname).toBe("/reset-password");

    const resetResponse = await send(app, "/auth/reset-password", {
      body: {
        newPassword: resetPasswordValue,
        token: extractToken(resetUrl),
      },
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(resetResponse.status).toBe(200);
    expect(await parseJson(resetResponse)).toMatchObject({
      user: {
        email,
        status: "active",
      },
    });
    expect(logger.messages.some((line) => line.includes("[auth:dev-mail] verification email"))).toBe(
      true
    );
    expect(
      logger.messages.some((line) => line.includes("[auth:dev-mail] password reset email"))
    ).toBe(true);
  });

  it("keeps me and logout correct for anonymous and active sessions while public routes stay open", async () => {
    const mailer = new CapturingAuthMailer();
    const app = createTestApp({ mailer });

    const anonymousMe = await send(app, "/auth/me");
    expect(anonymousMe.status).toBe(200);
    expect(await parseJson(anonymousMe)).toEqual({ user: null });
    expect(anonymousMe.headers.get("set-cookie")).toBeNull();

    const anonymousLogout = await send(app, "/auth/logout", {
      headers: {
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(anonymousLogout.status).toBe(204);
    expect(anonymousLogout.headers.get("set-cookie")).toContain("Max-Age=0");

    const activeUser = await createActiveUser(app, mailer, "active-session@example.com");

    const activeMe = await send(app, "/auth/me", {
      headers: {
        cookie: activeUser.cookie,
      },
    });

    expect(activeMe.status).toBe(200);
    expect(await parseJson(activeMe)).toMatchObject({
      user: {
        email: "active-session@example.com",
        status: "active",
      },
    });
    expect(activeMe.headers.get("set-cookie")).toBeNull();

    const activeLogout = await send(app, "/auth/logout", {
      headers: {
        cookie: activeUser.cookie,
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(activeLogout.status).toBe(204);
    expect(activeLogout.headers.get("set-cookie")).toContain("Max-Age=0");

    const loggedOutSession = await getAuthDb()
      .selectFrom("auth_sessions")
      .select("revoked_at")
      .where("token_hash", "=", hashOpaqueToken(activeUser.cookie.split("=")[1]!))
      .executeTakeFirstOrThrow();

    expect(loggedOutSession.revoked_at).not.toBeNull();

    const publicRouteResponse = await send(app, "/lists");
    expect(publicRouteResponse.status).toBe(200);
  });

  it("clears pending, disabled, expired, revoked, and invalid sessions from me and logout", async () => {
    const mailer = new CapturingAuthMailer();
    const app = createTestApp({ mailer });

    const pendingEmail = "pending-session@example.com";
    await registerPendingUser(app, mailer, { email: pendingEmail });
    const pendingUser = await getAuthDb()
      .selectFrom("users")
      .select("id")
      .where("email", "=", pendingEmail)
      .executeTakeFirstOrThrow();
    const pendingToken = "pending-session-token";
    await insertSessionForUser(pendingUser.id, pendingToken);

    const pendingResponse = await send(app, "/auth/me", {
      headers: {
        cookie: `pginbox_session=${pendingToken}`,
      },
    });

    expect(pendingResponse.status).toBe(200);
    expect(await parseJson(pendingResponse)).toEqual({ user: null });
    expect(pendingResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const revokedPendingSession = await getAuthDb()
      .selectFrom("auth_sessions")
      .select("revoked_at")
      .where("token_hash", "=", hashOpaqueToken(pendingToken))
      .executeTakeFirstOrThrow();

    expect(revokedPendingSession.revoked_at).not.toBeNull();

    const disabledUser = await createActiveUser(app, mailer, "disabled-session@example.com");
    await getAuthDb()
      .updateTable("users")
      .set({
        disable_reason: "disabled in test",
        disabled_at: new Date(),
        status: "disabled",
      })
      .where("email", "=", "disabled-session@example.com")
      .execute();

    const disabledResponse = await send(app, "/auth/me", {
      headers: {
        cookie: disabledUser.cookie,
      },
    });

    expect(disabledResponse.status).toBe(200);
    expect(await parseJson(disabledResponse)).toEqual({ user: null });
    expect(disabledResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const disabledSessionRows = await getAuthDb()
      .selectFrom("auth_sessions")
      .select("revoked_at")
      .innerJoin("users", "users.id", "auth_sessions.user_id")
      .where("users.email", "=", "disabled-session@example.com")
      .execute();

    expect(disabledSessionRows.every((row) => row.revoked_at !== null)).toBe(true);

    const expiredUser = await createActiveUser(app, mailer, "expired-session@example.com");
    await getAuthDb()
      .updateTable("auth_sessions")
      .set({
        created_at: new Date("2026-03-14T10:00:00.000Z"),
        expires_at: new Date("2026-03-14T11:00:00.000Z"),
        last_seen_at: new Date("2026-03-14T10:30:00.000Z"),
      })
      .where("token_hash", "=", hashOpaqueToken(expiredUser.cookie.split("=")[1]!))
      .execute();

    const expiredResponse = await send(app, "/auth/me", {
      headers: {
        cookie: expiredUser.cookie,
      },
    });

    expect(expiredResponse.status).toBe(200);
    expect(await parseJson(expiredResponse)).toEqual({ user: null });
    expect(expiredResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const expiredSession = await getAuthDb()
      .selectFrom("auth_sessions")
      .select("revoked_at")
      .where("token_hash", "=", hashOpaqueToken(expiredUser.cookie.split("=")[1]!))
      .executeTakeFirstOrThrow();

    expect(expiredSession.revoked_at).not.toBeNull();

    const revokedUser = await createActiveUser(app, mailer, "revoked-session@example.com");
    await getAuthDb()
      .updateTable("auth_sessions")
      .set({
        revoked_at: new Date(),
      })
      .where("token_hash", "=", hashOpaqueToken(revokedUser.cookie.split("=")[1]!))
      .execute();

    const revokedResponse = await send(app, "/auth/me", {
      headers: {
        cookie: revokedUser.cookie,
      },
    });

    expect(revokedResponse.status).toBe(200);
    expect(await parseJson(revokedResponse)).toEqual({ user: null });
    expect(revokedResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const invalidResponse = await send(app, "/auth/me", {
      headers: {
        cookie: "pginbox_session=not-a-real-session",
      },
    });

    expect(invalidResponse.status).toBe(200);
    expect(await parseJson(invalidResponse)).toEqual({ user: null });
    expect(invalidResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    const staleLogout = await send(app, "/auth/logout", {
      headers: {
        cookie: "pginbox_session=not-a-real-session",
        origin: frontendOrigin,
      },
      method: "POST",
    });

    expect(staleLogout.status).toBe(204);
    expect(staleLogout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("covers verify-email and login state handling and sets secure cookies in production", async () => {
    await withNodeEnv("production", async () => {
      const mailer = new CapturingAuthMailer();
      const app = createTestApp({ mailer });

      const activeEmail = "production-active@example.com";
      const verificationToken = await registerPendingUser(app, mailer, {
        email: activeEmail,
      });

      const activeVerification = await verifyUser(app, verificationToken);
      expect(activeVerification.setCookie).toContain("Secure");
      expect(activeVerification.setCookie).toContain("HttpOnly");
      expect(activeVerification.setCookie).toContain("SameSite=Lax");

      const pendingEmail = "pending-login@example.com";
      await registerPendingUser(app, mailer, { email: pendingEmail });

      const pendingLogin = await send(app, "/auth/login", {
        body: {
          email: pendingEmail,
          password: initialPassword,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(pendingLogin.status).toBe(403);
      expect(await parseJson(pendingLogin)).toEqual({
        code: "EMAIL_NOT_VERIFIED",
        message: "Email verification is required",
      });

      const invalidLogin = await send(app, "/auth/login", {
        body: {
          email: activeEmail,
          password: "wrong password value",
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(invalidLogin.status).toBe(401);
      expect(await parseJson(invalidLogin)).toEqual({
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      });

      await getAuthDb()
        .updateTable("users")
        .set({
          disable_reason: "disabled in test",
          disabled_at: new Date(),
          status: "disabled",
        })
        .where("email", "=", activeEmail)
        .execute();

      const disabledLogin = await send(app, "/auth/login", {
        body: {
          email: activeEmail,
          password: initialPassword,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(disabledLogin.status).toBe(403);
      expect(await parseJson(disabledLogin)).toEqual({
        code: "ACCOUNT_DISABLED",
        message: "This account is disabled",
      });

      const invalidVerify = await send(app, "/auth/verify-email", {
        body: { token: "not-a-real-token" },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(invalidVerify.status).toBe(400);
      expect(await parseJson(invalidVerify)).toEqual({
        code: "TOKEN_INVALID",
        message: "The token is invalid",
      });

      const expiredEmail = "expired-verify@example.com";
      const expiredToken = await registerPendingUser(app, mailer, { email: expiredEmail });
      await getAuthDb()
        .updateTable("email_verification_tokens")
        .set({
          created_at: new Date("2026-03-10T10:00:00.000Z"),
          expires_at: new Date("2026-03-11T10:00:00.000Z"),
        })
        .where("token_hash", "=", hashOpaqueToken(expiredToken))
        .execute();

      const expiredVerify = await send(app, "/auth/verify-email", {
        body: { token: expiredToken },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(expiredVerify.status).toBe(400);
      expect(await parseJson(expiredVerify)).toEqual({
        code: "TOKEN_EXPIRED",
        message: "The token has expired",
      });

      const disabledVerifyEmail = "disabled-verify@example.com";
      const disabledVerifyToken = await registerPendingUser(app, mailer, {
        email: disabledVerifyEmail,
      });

      await getAuthDb()
        .updateTable("users")
        .set({
          disable_reason: "disabled in test",
          disabled_at: new Date(),
          status: "disabled",
        })
        .where("email", "=", disabledVerifyEmail)
        .execute();

      const disabledVerify = await send(app, "/auth/verify-email", {
        body: { token: disabledVerifyToken },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(disabledVerify.status).toBe(403);
      expect(await parseJson(disabledVerify)).toEqual({
        code: "ACCOUNT_DISABLED",
        message: "This account is disabled",
      });

      const loginEmail = "login-active@example.com";
      await createActiveUser(app, mailer, loginEmail);

      const activeLogin = await send(app, "/auth/login", {
        body: {
          email: loginEmail,
          password: initialPassword,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(activeLogin.status).toBe(200);
      expect(await parseJson(activeLogin)).toMatchObject({
        user: {
          email: loginEmail,
          status: "active",
        },
      });
      expect(activeLogin.headers.get("set-cookie")).toContain("Secure");
      expect(activeLogin.headers.get("set-cookie")).toContain("HttpOnly");
      expect(activeLogin.headers.get("set-cookie")).toContain("SameSite=Lax");
    });
  });

  it("consumes password reset tokens, rotates the password hash, revokes old sessions, and creates a fresh session", async () => {
    await withNodeEnv("production", async () => {
      const mailer = new CapturingAuthMailer();
      const app = createTestApp({ mailer });
      const email = "password-reset@example.com";
      const originalSession = await createActiveUser(app, mailer, email);

      const extraLogin = await send(app, "/auth/login", {
        body: {
          email,
          password: initialPassword,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(extraLogin.status).toBe(200);

      const passwordBeforeReset = await getAuthDb()
        .selectFrom("users")
        .select(["id", "password_hash"])
        .where("email", "=", email)
        .executeTakeFirstOrThrow();

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

      const resetToken = extractToken(mailer.passwordResetUrls.at(-1)!);
      const resetResponse = await send(app, "/auth/reset-password", {
        body: {
          newPassword: resetPasswordValue,
          token: resetToken,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(resetResponse.status).toBe(200);
      expect(await parseJson(resetResponse)).toMatchObject({
        user: {
          email,
          status: "active",
        },
      });

      const resetSetCookie = resetResponse.headers.get("set-cookie");
      expect(resetSetCookie).toContain("Secure");
      expect(resetSetCookie).toContain("HttpOnly");
      expect(resetSetCookie).toContain("SameSite=Lax");

      const passwordAfterReset = await getAuthDb()
        .selectFrom("users")
        .select("password_hash")
        .where("email", "=", email)
        .executeTakeFirstOrThrow();

      expect(passwordAfterReset.password_hash).not.toBe(passwordBeforeReset.password_hash);
      expect(await verifyPassword(initialPassword, passwordAfterReset.password_hash)).toBe(false);
      expect(await verifyPassword(resetPasswordValue, passwordAfterReset.password_hash)).toBe(true);

      const resetTokenRow = await getAuthDb()
        .selectFrom("password_reset_tokens")
        .select("consumed_at")
        .where("token_hash", "=", hashOpaqueToken(resetToken))
        .executeTakeFirstOrThrow();

      expect(resetTokenRow.consumed_at).not.toBeNull();

      const sessionRows = await getAuthDb()
        .selectFrom("auth_sessions")
        .select(["token_hash", "revoked_at"])
        .where("user_id", "=", passwordBeforeReset.id)
        .execute();

      const activeSessionRows = sessionRows.filter((row) => row.revoked_at === null);
      expect(activeSessionRows).toHaveLength(1);
      expect(activeSessionRows[0]?.token_hash).not.toBe(
        hashOpaqueToken(originalSession.cookie.split("=")[1]!)
      );

      const refreshedCookie = sessionCookie(resetSetCookie!);
      const meAfterReset = await send(app, "/auth/me", {
        headers: {
          cookie: refreshedCookie,
        },
      });

      expect(meAfterReset.status).toBe(200);
      expect(await parseJson(meAfterReset)).toMatchObject({
        user: {
          email,
          status: "active",
        },
      });

      const reusedResetToken = await send(app, "/auth/reset-password", {
        body: {
          newPassword: "this should not be used twice",
          token: resetToken,
        },
        headers: {
          origin: frontendOrigin,
        },
        method: "POST",
      });

      expect(reusedResetToken.status).toBe(400);
      expect(await parseJson(reusedResetToken)).toEqual({
        code: "TOKEN_INVALID",
        message: "The token is invalid",
      });
    });
  });
});
