import type { Kysely } from "kysely";
import type {
  AuthForgotPasswordRequest,
  AuthLoginRequest,
  AuthRegisterRequest,
  AuthResetPasswordRequest,
  AuthResendVerificationRequest,
  AuthVerifyEmailRequest,
} from "shared/api";
import {
  AuthError,
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  SESSION_TTL_MS,
  assertValidEmail,
  assertValidPassword,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  normalizeDisplayName,
  normalizeEmail,
  runDummyPasswordVerification,
  tokenHashMatches,
  verifyPassword,
  type AuthSessionRecord,
  type AuthUserRecord,
  type SessionRequestMetadata,
} from "../auth";
import { resolveAuthAppBaseUrl, resolveAuthEmailRuntimeConfig, type AuthEmailRuntimeConfig } from "../config";
import { db as defaultDb } from "../db";
import { createAuthEmailSender, type AuthEmailSender } from "../email";
import type { DB } from "../types/db.d.ts";

type DatabaseClient = Kysely<DB>;

interface UserCredentialsRow {
  created_at: Date | string;
  disable_reason: string | null;
  disabled_at: Date | string | null;
  display_name: string | null;
  email: string;
  email_verified_at: Date | string | null;
  id: bigint | number | string;
  last_login_at: Date | string | null;
  password_hash: string;
  status: AuthUserRecord["status"];
}

interface VerificationTokenRow {
  consumed_at: Date | string | null;
  email: string;
  expires_at: Date | string;
  token_hash: string;
  user_created_at: Date | string;
  user_display_name: string | null;
  user_email: string;
  user_email_verified_at: Date | string | null;
  user_id: bigint | number | string;
  user_status: AuthUserRecord["status"];
}

interface PasswordResetTokenRow {
  consumed_at: Date | string | null;
  expires_at: Date | string;
  token_hash: string;
  user_created_at: Date | string;
  user_display_name: string | null;
  user_email: string;
  user_email_verified_at: Date | string | null;
  user_id: bigint | number | string;
  user_status: AuthUserRecord["status"];
}

export interface AuthFlowResult {
  session: AuthSessionRecord;
  sessionToken: string;
  user: AuthUserRecord;
}

export interface RegisterResult {
  developmentVerificationUrl: string | null;
  user: AuthUserRecord | null;
  verificationEmailSent: boolean;
}

export interface ResendVerificationResult {
  developmentVerificationUrl: string | null;
  user: AuthUserRecord | null;
  verificationEmailSent: boolean;
}

export interface ForgotPasswordResult {
  passwordResetEmailSent: boolean;
  user: AuthUserRecord | null;
}

export interface LogoutResult {
  revoked: boolean;
}

export interface AuthServiceDependencies {
  appBaseUrl?: string;
  db?: DatabaseClient;
  emailRuntimeConfig?: AuthEmailRuntimeConfig;
  mailer?: AuthEmailSender;
  now?: () => Date;
}

export interface PasswordResetTokenLookupResult {
  email: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function resolveAppBaseUrl(
  appBaseUrl: string | undefined,
  emailRuntimeConfig: AuthEmailRuntimeConfig,
): string {
  if (appBaseUrl) {
    try {
      return new URL(appBaseUrl).toString();
    } catch {
      throw new Error("APP_BASE_URL must be a valid absolute URL");
    }
  }

  if (emailRuntimeConfig.mode === "smtp") {
    throw new Error("AUTH_EMAIL_MODE=smtp requires APP_BASE_URL");
  }

  return resolveAuthAppBaseUrl();
}

function toAuthUserRecord(row: {
  created_at: Date | string;
  display_name: string | null;
  email: string;
  email_verified_at: Date | string | null;
  id: bigint | number | string;
  status: string;
}): AuthUserRecord {
  return {
    created_at: row.created_at,
    display_name: row.display_name,
    email: row.email,
    email_verified_at: row.email_verified_at,
    id: row.id,
    status: row.status as AuthUserRecord["status"],
  };
}

function buildFrontendUrl(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function hasDisplayNameOverride(input: AuthRegisterRequest): boolean {
  return Object.prototype.hasOwnProperty.call(input, "displayName");
}

function validateLoginInput(input: AuthLoginRequest): { email: string; password: string; isValid: boolean } {
  const email = normalizeEmail(input.email);
  const password = input.password;

  if (!email || !password) {
    return { email, password, isValid: false };
  }

  if (password.length === 0) {
    return { email, password, isValid: false };
  }

  return {
    email,
    password,
    isValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  };
}

async function findUserByEmail(
  authDb: DatabaseClient,
  email: string
): Promise<UserCredentialsRow | null> {
  const row = await authDb
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();

  return (row as UserCredentialsRow | undefined) ?? null;
}

async function rotateVerificationToken(
  authDb: DatabaseClient,
  user: AuthUserRecord,
  now: Date
): Promise<{ expiresAt: Date; token: string }> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS);

  await authDb
    .updateTable("email_verification_tokens")
    .set({ consumed_at: now })
    .where("user_id", "=", user.id)
    .where("consumed_at", "is", null)
    .execute();

  await authDb
    .insertInto("email_verification_tokens")
    .values({
      consumed_at: null,
      email: user.email,
      expires_at: expiresAt,
      token_hash: hashOpaqueToken(token),
      user_id: user.id,
    })
    .execute();

  return { expiresAt, token };
}

async function rotatePasswordResetToken(
  authDb: DatabaseClient,
  user: AuthUserRecord,
  now: Date
): Promise<{ expiresAt: Date; token: string }> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);

  await authDb
    .updateTable("password_reset_tokens")
    .set({ consumed_at: now })
    .where("user_id", "=", user.id)
    .where("consumed_at", "is", null)
    .execute();

  await authDb
    .insertInto("password_reset_tokens")
    .values({
      consumed_at: null,
      expires_at: expiresAt,
      token_hash: hashOpaqueToken(token),
      user_id: user.id,
    })
    .execute();

  return { expiresAt, token };
}

async function revokeAllSessionsForUser(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  now: Date
): Promise<void> {
  await authDb
    .updateTable("auth_sessions")
    .set({ revoked_at: now })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}

async function createSessionForUser(
  authDb: DatabaseClient,
  user: AuthUserRecord,
  metadata: SessionRequestMetadata | undefined,
  now: Date
): Promise<{ session: AuthSessionRecord; sessionToken: string }> {
  if (user.status === "disabled") {
    throw new AuthError(403, "ACCOUNT_DISABLED", "This account is disabled");
  }

  if (user.status !== "active" || user.email_verified_at === null) {
    throw new AuthError(403, "EMAIL_NOT_VERIFIED", "Email verification is required");
  }

  const sessionToken = generateOpaqueToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const inserted = await authDb
    .insertInto("auth_sessions")
    .values({
      expires_at: expiresAt,
      ip_address: metadata?.ipAddress ?? null,
      revoked_at: null,
      token_hash: hashOpaqueToken(sessionToken),
      user_agent: metadata?.userAgent ?? null,
      user_id: user.id,
    })
    .returning([
      "id",
      "user_id",
      "created_at",
      "last_seen_at",
      "expires_at",
      "revoked_at",
      "ip_address",
      "user_agent",
    ])
    .executeTakeFirstOrThrow();

  return {
    session: {
      created_at: inserted.created_at,
      expires_at: inserted.expires_at,
      id: inserted.id,
      ip_address: inserted.ip_address,
      last_seen_at: inserted.last_seen_at,
      revoked_at: inserted.revoked_at,
      user_agent: inserted.user_agent,
      user_id: inserted.user_id,
    },
    sessionToken,
  };
}

async function findVerificationToken(
  authDb: DatabaseClient,
  tokenHash: string
): Promise<VerificationTokenRow | null> {
  const row = await authDb
    .selectFrom("email_verification_tokens")
    .innerJoin("users", "users.id", "email_verification_tokens.user_id")
    .select([
      "email_verification_tokens.email",
      "email_verification_tokens.token_hash",
      "email_verification_tokens.expires_at",
      "email_verification_tokens.consumed_at",
      "users.id as user_id",
      "users.email as user_email",
      "users.display_name as user_display_name",
      "users.status as user_status",
      "users.email_verified_at as user_email_verified_at",
      "users.created_at as user_created_at",
    ])
    .where("email_verification_tokens.token_hash", "=", tokenHash)
    .executeTakeFirst();

  return (row as VerificationTokenRow | undefined) ?? null;
}

async function findPasswordResetToken(
  authDb: DatabaseClient,
  tokenHash: string
): Promise<PasswordResetTokenRow | null> {
  const row = await authDb
    .selectFrom("password_reset_tokens")
    .innerJoin("users", "users.id", "password_reset_tokens.user_id")
    .select([
      "password_reset_tokens.token_hash",
      "password_reset_tokens.expires_at",
      "password_reset_tokens.consumed_at",
      "users.id as user_id",
      "users.email as user_email",
      "users.display_name as user_display_name",
      "users.status as user_status",
      "users.email_verified_at as user_email_verified_at",
      "users.created_at as user_created_at",
    ])
    .where("password_reset_tokens.token_hash", "=", tokenHash)
    .executeTakeFirst();

  return (row as PasswordResetTokenRow | undefined) ?? null;
}

function throwInvalidCredentials(): never {
  throw new AuthError(401, "INVALID_CREDENTIALS", "Invalid email or password");
}

function throwInvalidToken(): never {
  throw new AuthError(400, "TOKEN_INVALID", "The token is invalid");
}

function throwExpiredToken(): never {
  throw new AuthError(400, "TOKEN_EXPIRED", "The token has expired");
}

export function createAuthService(dependencies: AuthServiceDependencies = {}) {
  const authDb = dependencies.db ?? defaultDb;
  const emailRuntimeConfig =
    dependencies.emailRuntimeConfig ?? resolveAuthEmailRuntimeConfig();
  const mailer = dependencies.mailer ?? createAuthEmailSender(console, emailRuntimeConfig);
  const now = dependencies.now ?? (() => new Date());
  const appBaseUrl = resolveAppBaseUrl(
    dependencies.appBaseUrl ?? process.env.APP_BASE_URL,
    emailRuntimeConfig,
  );

  return {
    async register(input: AuthRegisterRequest): Promise<RegisterResult> {
      const email = normalizeEmail(input.email);
      const displayName = normalizeDisplayName(input.displayName);

      assertValidEmail(email);
      assertValidPassword(input.password);

      const existingUser = await findUserByEmail(authDb, email);
      if (existingUser && existingUser.status !== "pending_verification") {
        return {
          developmentVerificationUrl: null,
          user: null,
          verificationEmailSent: false,
        };
      }

      const passwordHash = await hashPassword(input.password);
      const currentTime = now();

      const result = await authDb.transaction().execute(async (trx) => {
        const pendingUser = await findUserByEmail(trx, email);

        if (!pendingUser) {
          const insertedUser = await trx
            .insertInto("users")
            .values({
              display_name: displayName,
              email,
              email_verified_at: null,
              password_hash: passwordHash,
              status: "pending_verification",
            })
            .returning(["id", "email", "display_name", "status", "email_verified_at", "created_at"])
            .executeTakeFirstOrThrow();

          const user = toAuthUserRecord(insertedUser);
          const verification = await rotateVerificationToken(trx, user, currentTime);

          return { user, verification };
        }

        if (pendingUser.status !== "pending_verification") {
          return { user: null, verification: null };
        }

        const updatedUser = await trx
          .updateTable("users")
          .set({
            display_name: hasDisplayNameOverride(input) ? displayName : pendingUser.display_name,
            password_hash: passwordHash,
          })
          .where("id", "=", pendingUser.id)
          .returning(["id", "email", "display_name", "status", "email_verified_at", "created_at"])
          .executeTakeFirstOrThrow();

        const user = toAuthUserRecord(updatedUser);
        const verification = await rotateVerificationToken(trx, user, currentTime);

        return { user, verification };
      });

      if (!result.user || !result.verification) {
        return {
          developmentVerificationUrl: null,
          user: null,
          verificationEmailSent: false,
        };
      }

      const verificationUrl = buildFrontendUrl(
        appBaseUrl,
        "/verify-email",
        result.verification.token
      );

      await mailer.sendVerificationEmail({
        displayName: result.user.display_name,
        email: result.user.email,
        expiresAt: result.verification.expiresAt,
        verificationUrl,
      });

      return {
        developmentVerificationUrl:
          emailRuntimeConfig.mode === "dev-auto-verify" ? verificationUrl : null,
        user: result.user,
        verificationEmailSent: true,
      };
    },

    async resendVerification(
      input: AuthResendVerificationRequest
    ): Promise<ResendVerificationResult> {
      const email = normalizeEmail(input.email);
      assertValidEmail(email);

      const user = await findUserByEmail(authDb, email);
      if (!user || user.status !== "pending_verification") {
        return {
          developmentVerificationUrl: null,
          user: null,
          verificationEmailSent: false,
        };
      }

      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, toAuthUserRecord(user), currentTime);
      });

      const authUser = toAuthUserRecord(user);
      const verificationUrl = buildFrontendUrl(appBaseUrl, "/verify-email", verification.token);
      await mailer.sendVerificationEmail({
        displayName: authUser.display_name,
        email: authUser.email,
        expiresAt: verification.expiresAt,
        verificationUrl,
      });

      return {
        developmentVerificationUrl:
          emailRuntimeConfig.mode === "dev-auto-verify" ? verificationUrl : null,
        user: authUser,
        verificationEmailSent: true,
      };
    },

    async verifyEmail(
      input: AuthVerifyEmailRequest,
      metadata?: SessionRequestMetadata
    ): Promise<AuthFlowResult> {
      const rawToken = input.token.trim();
      if (!rawToken) throwInvalidToken();

      const currentTime = now();
      const tokenHash = hashOpaqueToken(rawToken);

      return authDb.transaction().execute(async (trx) => {
        const tokenRecord = await findVerificationToken(trx, tokenHash);
        if (!tokenRecord || tokenRecord.consumed_at !== null || !tokenHashMatches(rawToken, tokenRecord.token_hash)) {
          throwInvalidToken();
        }

        if (toDate(tokenRecord.expires_at).getTime() <= currentTime.getTime()) {
          throwExpiredToken();
        }

        if (tokenRecord.user_status === "disabled") {
          await revokeAllSessionsForUser(trx, tokenRecord.user_id, currentTime);
          throw new AuthError(403, "ACCOUNT_DISABLED", "This account is disabled");
        }

        await trx
          .updateTable("email_verification_tokens")
          .set({ consumed_at: currentTime })
          .where("user_id", "=", tokenRecord.user_id)
          .where("consumed_at", "is", null)
          .execute();

        const updatedUser = await trx
          .updateTable("users")
          .set({
            email_verified_at:
              tokenRecord.user_email_verified_at ?? currentTime,
            status: "active",
          })
          .where("id", "=", tokenRecord.user_id)
          .returning(["id", "email", "display_name", "status", "email_verified_at", "created_at"])
          .executeTakeFirstOrThrow();

        const user = toAuthUserRecord(updatedUser);
        const { session, sessionToken } = await createSessionForUser(trx, user, metadata, currentTime);

        return {
          session,
          sessionToken,
          user,
        };
      });
    },

    async login(input: AuthLoginRequest, metadata?: SessionRequestMetadata): Promise<AuthFlowResult> {
      const { email, password, isValid } = validateLoginInput(input);
      const user = isValid ? await findUserByEmail(authDb, email) : null;

      if (!user) {
        await runDummyPasswordVerification(password);
        throwInvalidCredentials();
      }

      const passwordMatches = await verifyPassword(password, user.password_hash);
      if (!passwordMatches) {
        throwInvalidCredentials();
      }

      if (user.status === "pending_verification" || user.email_verified_at === null) {
        throw new AuthError(403, "EMAIL_NOT_VERIFIED", "Email verification is required");
      }

      if (user.status === "disabled") {
        await revokeAllSessionsForUser(authDb, user.id, now());
        throw new AuthError(403, "ACCOUNT_DISABLED", "This account is disabled");
      }

      const currentTime = now();

      return authDb.transaction().execute(async (trx) => {
        const authUser = toAuthUserRecord(user);
        const { session, sessionToken } = await createSessionForUser(trx, authUser, metadata, currentTime);

        await trx
          .updateTable("users")
          .set({ last_login_at: currentTime })
          .where("id", "=", user.id)
          .execute();

        return {
          session,
          sessionToken,
          user: authUser,
        };
      });
    },

    async logout(sessionId: bigint | number | string | null | undefined): Promise<LogoutResult> {
      if (sessionId == null) {
        return { revoked: false };
      }

      const currentTime = now();
      const result = await authDb
        .updateTable("auth_sessions")
        .set({ revoked_at: currentTime })
        .where("id", "=", sessionId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();

      return { revoked: Number(result.numUpdatedRows ?? 0n) > 0 };
    },

    async forgotPassword(input: AuthForgotPasswordRequest): Promise<ForgotPasswordResult> {
      const email = normalizeEmail(input.email);
      assertValidEmail(email);

      const user = await findUserByEmail(authDb, email);
      if (!user || user.status !== "active" || user.email_verified_at === null) {
        return { passwordResetEmailSent: false, user: null };
      }

      const authUser = toAuthUserRecord(user);
      const currentTime = now();
      const resetToken = await authDb.transaction().execute(async (trx) => {
        return rotatePasswordResetToken(trx, authUser, currentTime);
      });

      await mailer.sendPasswordResetEmail({
        displayName: authUser.display_name,
        email: authUser.email,
        expiresAt: resetToken.expiresAt,
        resetUrl: buildFrontendUrl(appBaseUrl, "/reset-password", resetToken.token),
      });

      return {
        passwordResetEmailSent: true,
        user: authUser,
      };
    },

    async lookupPasswordResetEmail(token: string): Promise<PasswordResetTokenLookupResult | null> {
      const rawToken = token.trim();
      if (!rawToken) return null;

      const tokenHash = hashOpaqueToken(rawToken);
      const tokenRecord = await findPasswordResetToken(authDb, tokenHash);
      if (!tokenRecord || !tokenHashMatches(rawToken, tokenRecord.token_hash)) {
        return null;
      }

      return {
        email: tokenRecord.user_email,
      };
    },

    async resetPassword(
      input: AuthResetPasswordRequest,
      metadata?: SessionRequestMetadata
    ): Promise<AuthFlowResult> {
      const rawToken = input.token.trim();
      if (!rawToken) throwInvalidToken();

      assertValidPassword(input.newPassword);
      const nextPasswordHash = await hashPassword(input.newPassword);
      const currentTime = now();
      const tokenHash = hashOpaqueToken(rawToken);

      return authDb.transaction().execute(async (trx) => {
        const tokenRecord = await findPasswordResetToken(trx, tokenHash);
        if (!tokenRecord || tokenRecord.consumed_at !== null || !tokenHashMatches(rawToken, tokenRecord.token_hash)) {
          throwInvalidToken();
        }

        if (toDate(tokenRecord.expires_at).getTime() <= currentTime.getTime()) {
          throwExpiredToken();
        }

        if (tokenRecord.user_status === "disabled") {
          await revokeAllSessionsForUser(trx, tokenRecord.user_id, currentTime);
          throw new AuthError(403, "ACCOUNT_DISABLED", "This account is disabled");
        }

        await trx
          .updateTable("password_reset_tokens")
          .set({ consumed_at: currentTime })
          .where("user_id", "=", tokenRecord.user_id)
          .where("consumed_at", "is", null)
          .execute();

        const updatedUser = await trx
          .updateTable("users")
          .set({ password_hash: nextPasswordHash })
          .where("id", "=", tokenRecord.user_id)
          .returning(["id", "email", "display_name", "status", "email_verified_at", "created_at"])
          .executeTakeFirstOrThrow();

        const user = toAuthUserRecord(updatedUser);
        await revokeAllSessionsForUser(trx, tokenRecord.user_id, currentTime);
        const { session, sessionToken } = await createSessionForUser(trx, user, metadata, currentTime);

        return {
          session,
          sessionToken,
          user,
        };
      });
    },
  };
}

export const authService = createAuthService();

export type AuthService = ReturnType<typeof createAuthService>;
