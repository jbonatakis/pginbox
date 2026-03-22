import type { Kysely } from "kysely";
import type {
  AccountProfileUpdateRequest,
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
import { toDbInt8 } from "../db-ids";
import { runParticipationBackfillForUser } from "./thread-progress.service";
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
  role: string;
  status: AuthUserRecord["status"];
}

interface VerificationTokenRow {
  consumed_at: Date | string | null;
  email: string;
  expires_at: Date | string;
  token_hash: string;
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
  user_role: string;
  user_status: AuthUserRecord["status"];
}

export interface UserEmailRecord {
  id: bigint | number | string;
  email: string;
  is_primary: boolean;
  verified_at: Date | string | null;
  created_at: Date | string;
}

export interface AuthFlowResult {
  session: AuthSessionRecord;
  sessionToken: string;
  user: AuthUserRecord;
}

export interface VerifyEmailResult {
  isRegistration: boolean;
  session: AuthSessionRecord | null;
  sessionToken: string | null;
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

export interface AddEmailResult {
  developmentVerificationUrl: string | null;
  verificationEmailSent: boolean;
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
  role: string;
  status: string;
}): AuthUserRecord {
  return {
    created_at: row.created_at,
    display_name: row.display_name,
    email: row.email,
    email_verified_at: row.email_verified_at,
    id: row.id,
    role: row.role,
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

// Find a user by their primary email address
async function findUserByPrimaryEmail(
  authDb: DatabaseClient,
  email: string
): Promise<UserCredentialsRow | null> {
  const row = await (authDb as any)
    .selectFrom("users")
    .innerJoin("user_emails as ue", (join: any) =>
      join.onRef("ue.user_id", "=", "users.id")
          .on("ue.email", "=", email)
          .on("ue.is_primary", "=", true)
    )
    .select([
      "users.id",
      "users.display_name",
      "users.password_hash",
      "users.role",
      "users.status",
      "users.last_login_at",
      "users.disabled_at",
      "users.disable_reason",
      "users.created_at",
      "ue.email",
      "ue.verified_at as email_verified_at",
    ])
    .executeTakeFirst();

  return (row as UserCredentialsRow | undefined) ?? null;
}

// Fetch a user by ID with their primary email (used after updates)
async function findUserWithPrimaryEmailById(
  authDb: DatabaseClient,
  userId: bigint | number | string
): Promise<UserCredentialsRow | null> {
  const row = await (authDb as any)
    .selectFrom("users")
    .innerJoin("user_emails as ue", (join: any) =>
      join.onRef("ue.user_id", "=", "users.id")
          .on("ue.is_primary", "=", true)
    )
    .select([
      "users.id",
      "users.display_name",
      "users.password_hash",
      "users.role",
      "users.status",
      "users.last_login_at",
      "users.disabled_at",
      "users.disable_reason",
      "users.created_at",
      "ue.email",
      "ue.verified_at as email_verified_at",
    ])
    .where("users.id", "=", toDbInt8(userId))
    .executeTakeFirst();

  return (row as UserCredentialsRow | undefined) ?? null;
}

async function rotateVerificationToken(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  email: string,
  now: Date
): Promise<{ expiresAt: Date; token: string }> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS);

  // Consume any existing unconsumed token for this user+email pair
  await authDb
    .updateTable("email_verification_tokens")
    .set({ consumed_at: now })
    .where("user_id", "=", toDbInt8(userId))
    .where("email", "=", email)
    .where("consumed_at", "is", null)
    .execute();

  await authDb
    .insertInto("email_verification_tokens")
    .values({
      consumed_at: null,
      email,
      expires_at: expiresAt,
      token_hash: hashOpaqueToken(token),
      user_id: toDbInt8(userId),
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
    .where("user_id", "=", toDbInt8(user.id))
    .where("consumed_at", "is", null)
    .execute();

  await authDb
    .insertInto("password_reset_tokens")
    .values({
      consumed_at: null,
      expires_at: expiresAt,
      token_hash: hashOpaqueToken(token),
      user_id: toDbInt8(user.id),
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
    .where("user_id", "=", toDbInt8(userId))
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

  if (user.status !== "active") {
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
      user_id: toDbInt8(user.id),
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
      "users.status as user_status",
    ])
    .where("email_verification_tokens.token_hash", "=", tokenHash)
    .executeTakeFirst();

  return (row as VerificationTokenRow | undefined) ?? null;
}

async function findPasswordResetToken(
  authDb: DatabaseClient,
  tokenHash: string
): Promise<PasswordResetTokenRow | null> {
  const row = await (authDb as any)
    .selectFrom("password_reset_tokens")
    .innerJoin("users", "users.id", "password_reset_tokens.user_id")
    .innerJoin("user_emails as ue", (join: any) =>
      join.onRef("ue.user_id", "=", "users.id")
          .on("ue.is_primary", "=", true)
    )
    .select([
      "password_reset_tokens.token_hash",
      "password_reset_tokens.expires_at",
      "password_reset_tokens.consumed_at",
      "users.id as user_id",
      "users.display_name as user_display_name",
      "users.status as user_status",
      "users.role as user_role",
      "users.created_at as user_created_at",
      "ue.email as user_email",
      "ue.verified_at as user_email_verified_at",
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

      // Check if email is globally taken (as primary or secondary on any account)
      const existingEmailRow = await (authDb as any)
        .selectFrom("user_emails")
        .innerJoin("users", "users.id", "user_emails.user_id")
        .select(["users.id", "users.status", "user_emails.is_primary"])
        .where("user_emails.email", "=", email)
        .executeTakeFirst() as { id: bigint; status: string; is_primary: boolean } | undefined;

      if (existingEmailRow) {
        if (!existingEmailRow.is_primary || existingEmailRow.status !== "pending_verification") {
          return {
            developmentVerificationUrl: null,
            user: null,
            verificationEmailSent: false,
          };
        }
      }

      const passwordHash = await hashPassword(input.password);
      const currentTime = now();

      const result = await authDb.transaction().execute(async (trx) => {
        // Re-check inside transaction
        const pendingEmailRow = await (trx as any)
          .selectFrom("user_emails")
          .innerJoin("users", "users.id", "user_emails.user_id")
          .select(["users.id", "users.status", "users.display_name", "user_emails.is_primary"])
          .where("user_emails.email", "=", email)
          .executeTakeFirst() as { id: bigint; status: string; display_name: string | null; is_primary: boolean } | undefined;

        if (!pendingEmailRow) {
          // Create new user + primary email entry
          const insertedUser = await trx
            .insertInto("users")
            .values({
              display_name: displayName,
              password_hash: passwordHash,
              status: "pending_verification",
            })
            .returning(["id", "display_name", "role", "status", "created_at"])
            .executeTakeFirstOrThrow();

          await (trx as any)
            .insertInto("user_emails")
            .values({
              user_id: insertedUser.id,
              email,
              is_primary: true,
              verified_at: null,
            })
            .execute();

          const user = toAuthUserRecord({ ...insertedUser, email, email_verified_at: null });
          const verification = await rotateVerificationToken(trx, insertedUser.id, email, currentTime);
          return { user, verification };
        }

        if (!pendingEmailRow.is_primary || pendingEmailRow.status !== "pending_verification") {
          return { user: null, verification: null };
        }

        const updatedUser = await trx
          .updateTable("users")
          .set({
            display_name: hasDisplayNameOverride(input) ? displayName : pendingEmailRow.display_name,
            password_hash: passwordHash,
          })
          .where("id", "=", toDbInt8(pendingEmailRow.id))
          .returning(["id", "display_name", "role", "status", "created_at"])
          .executeTakeFirstOrThrow();

        const user = toAuthUserRecord({ ...updatedUser, email, email_verified_at: null });
        const verification = await rotateVerificationToken(trx, pendingEmailRow.id, email, currentTime);
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
        userId: result.user.id,
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

      const user = await findUserByPrimaryEmail(authDb, email);
      if (!user || user.status !== "pending_verification") {
        return {
          developmentVerificationUrl: null,
          user: null,
          verificationEmailSent: false,
        };
      }

      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, user.id, email, currentTime);
      });

      const authUser = toAuthUserRecord(user);
      const verificationUrl = buildFrontendUrl(appBaseUrl, "/verify-email", verification.token);
      await mailer.sendVerificationEmail({
        displayName: authUser.display_name,
        email: authUser.email,
        expiresAt: verification.expiresAt,
        userId: authUser.id,
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
    ): Promise<VerifyEmailResult> {
      const rawToken = input.token.trim();
      if (!rawToken) throwInvalidToken();

      const currentTime = now();
      const tokenHash = hashOpaqueToken(rawToken);

      const result = await authDb.transaction().execute(async (trx) => {
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

        // Consume the token (scoped to this user+email pair)
        await trx
          .updateTable("email_verification_tokens")
          .set({ consumed_at: currentTime })
          .where("user_id", "=", toDbInt8(tokenRecord.user_id))
          .where("email", "=", tokenRecord.email)
          .where("consumed_at", "is", null)
          .execute();

        // Mark the email as verified
        await (trx as any)
          .updateTable("user_emails")
          .set({ verified_at: currentTime })
          .where("user_id", "=", toDbInt8(tokenRecord.user_id))
          .where("email", "=", tokenRecord.email)
          .execute();

        const isRegistration = tokenRecord.user_status === "pending_verification";

        if (isRegistration) {
          await trx
            .updateTable("users")
            .set({ status: "active" })
            .where("id", "=", toDbInt8(tokenRecord.user_id))
            .execute();
        }

        const userRow = await findUserWithPrimaryEmailById(trx, tokenRecord.user_id);
        if (!userRow) {
          throw new AuthError(500, "INTERNAL_ERROR", "User not found after verification");
        }

        const user = toAuthUserRecord(userRow);

        if (isRegistration) {
          const { session, sessionToken } = await createSessionForUser(trx, user, metadata, currentTime);
          return { isRegistration: true, session, sessionToken, user, verifiedEmail: tokenRecord.email };
        }

        return { isRegistration: false, session: null, sessionToken: null, user, verifiedEmail: tokenRecord.email };
      });

      runParticipationBackfillForUser(String(result.user.id), result.verifiedEmail).catch((err) => {
        console.error(`participation backfill failed for user ${result.user.id}: ${err}`);
      });

      return {
        isRegistration: result.isRegistration,
        session: result.session,
        sessionToken: result.sessionToken,
        user: result.user,
      };
    },

    async login(input: AuthLoginRequest, metadata?: SessionRequestMetadata): Promise<AuthFlowResult> {
      const { email, password, isValid } = validateLoginInput(input);
      const user = isValid ? await findUserByPrimaryEmail(authDb, email) : null;

      if (!user) {
        await runDummyPasswordVerification(password);
        throwInvalidCredentials();
      }

      const passwordMatches = await verifyPassword(password, user.password_hash);
      if (!passwordMatches) {
        throwInvalidCredentials();
      }

      if (user.status === "pending_verification") {
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
          .where("id", "=", toDbInt8(user.id))
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
        .where("id", "=", toDbInt8(sessionId))
        .where("revoked_at", "is", null)
        .executeTakeFirst();

      return { revoked: Number(result.numUpdatedRows ?? 0n) > 0 };
    },

    async forgotPassword(input: AuthForgotPasswordRequest): Promise<ForgotPasswordResult> {
      const email = normalizeEmail(input.email);
      assertValidEmail(email);

      const user = await findUserByPrimaryEmail(authDb, email);
      if (!user || user.status !== "active") {
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
        userId: authUser.id,
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
          .where("user_id", "=", toDbInt8(tokenRecord.user_id))
          .where("consumed_at", "is", null)
          .execute();

        await trx
          .updateTable("users")
          .set({ password_hash: nextPasswordHash })
          .where("id", "=", toDbInt8(tokenRecord.user_id))
          .execute();

        const userRow = await findUserWithPrimaryEmailById(trx, tokenRecord.user_id);
        if (!userRow) {
          throw new AuthError(500, "INTERNAL_ERROR", "User not found after password reset");
        }

        const user = toAuthUserRecord(userRow);
        await revokeAllSessionsForUser(trx, tokenRecord.user_id, currentTime);
        const { session, sessionToken } = await createSessionForUser(trx, user, metadata, currentTime);

        return {
          session,
          sessionToken,
          user,
        };
      });
    },

    async updateProfile(
      userId: bigint | number | string,
      input: AccountProfileUpdateRequest
    ): Promise<AuthUserRecord> {
      const displayName = normalizeDisplayName(input.displayName);

      await authDb
        .updateTable("users")
        .set({ display_name: displayName })
        .where("id", "=", toDbInt8(userId))
        .execute();

      const updatedUser = await findUserWithPrimaryEmailById(authDb, userId);
      if (!updatedUser) {
        throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      }

      return toAuthUserRecord(updatedUser);
    },

    async listEmails(userId: bigint | number | string): Promise<UserEmailRecord[]> {
      const rows = await (authDb as any)
        .selectFrom("user_emails")
        .select(["id", "email", "is_primary", "verified_at", "created_at"])
        .where("user_id", "=", toDbInt8(userId))
        .orderBy("is_primary", "desc")
        .orderBy("created_at", "asc")
        .execute();

      return rows as UserEmailRecord[];
    },

    async addEmail(
      userId: bigint | number | string,
      email: string
    ): Promise<AddEmailResult> {
      const normalizedEmail = normalizeEmail(email);
      assertValidEmail(normalizedEmail);

      // Check if email is already registered anywhere — silent no-op if so
      const existing = await (authDb as any)
        .selectFrom("user_emails")
        .select(["id"])
        .where("email", "=", normalizedEmail)
        .executeTakeFirst();

      if (existing) {
        return { developmentVerificationUrl: null, verificationEmailSent: false };
      }

      const currentTime = now();

      await (authDb as any)
        .insertInto("user_emails")
        .values({
          user_id: toDbInt8(userId),
          email: normalizedEmail,
          is_primary: false,
          verified_at: null,
        })
        .execute();

      const user = await findUserWithPrimaryEmailById(authDb, userId);
      if (!user) {
        throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      }

      const authUser = toAuthUserRecord(user);
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, userId, normalizedEmail, currentTime);
      });

      const verificationUrl = buildFrontendUrl(appBaseUrl, "/verify-email", verification.token);
      await mailer.sendVerificationEmail({
        displayName: authUser.display_name,
        email: normalizedEmail,
        expiresAt: verification.expiresAt,
        userId: authUser.id,
        verificationUrl,
      });

      return {
        developmentVerificationUrl:
          emailRuntimeConfig.mode === "dev-auto-verify" ? verificationUrl : null,
        verificationEmailSent: true,
      };
    },

    async setPrimaryEmail(
      userId: bigint | number | string,
      emailId: bigint | number | string
    ): Promise<void> {
      const emailRow = await (authDb as any)
        .selectFrom("user_emails")
        .select(["id", "email", "is_primary", "verified_at"])
        .where("id", "=", toDbInt8(emailId))
        .where("user_id", "=", toDbInt8(userId))
        .executeTakeFirst() as { id: bigint; email: string; is_primary: boolean; verified_at: Date | null } | undefined;

      if (!emailRow) {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      if (emailRow.is_primary) {
        return;
      }

      if (!emailRow.verified_at) {
        throw new AuthError(400, "EMAIL_NOT_VERIFIED", "Only verified emails can be set as primary");
      }

      await authDb.transaction().execute(async (trx) => {
        await (trx as any)
          .updateTable("user_emails")
          .set({ is_primary: false })
          .where("user_id", "=", toDbInt8(userId))
          .where("is_primary", "=", true)
          .execute();

        await (trx as any)
          .updateTable("user_emails")
          .set({ is_primary: true })
          .where("id", "=", toDbInt8(emailId))
          .execute();
      });
    },

    async removeEmail(
      userId: bigint | number | string,
      emailId: bigint | number | string
    ): Promise<void> {
      const emailRow = await (authDb as any)
        .selectFrom("user_emails")
        .select(["id", "is_primary"])
        .where("id", "=", toDbInt8(emailId))
        .where("user_id", "=", toDbInt8(userId))
        .executeTakeFirst() as { id: bigint; is_primary: boolean } | undefined;

      if (!emailRow) {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      if (emailRow.is_primary) {
        throw new AuthError(
          400,
          "EMAIL_IS_PRIMARY",
          "Cannot remove the primary email. Set another email as primary first."
        );
      }

      await (authDb as any)
        .deleteFrom("user_emails")
        .where("id", "=", toDbInt8(emailId))
        .execute();
    },

    async resendVerificationForEmail(
      userId: bigint | number | string,
      emailId: bigint | number | string
    ): Promise<AddEmailResult> {
      const emailRow = await (authDb as any)
        .selectFrom("user_emails")
        .select(["id", "email", "verified_at"])
        .where("id", "=", toDbInt8(emailId))
        .where("user_id", "=", toDbInt8(userId))
        .executeTakeFirst() as { id: bigint; email: string; verified_at: Date | null } | undefined;

      if (!emailRow || emailRow.verified_at !== null) {
        return { developmentVerificationUrl: null, verificationEmailSent: false };
      }

      const user = await findUserWithPrimaryEmailById(authDb, userId);
      if (!user) {
        throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      }

      const authUser = toAuthUserRecord(user);
      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, userId, emailRow.email, currentTime);
      });

      const verificationUrl = buildFrontendUrl(appBaseUrl, "/verify-email", verification.token);
      await mailer.sendVerificationEmail({
        displayName: authUser.display_name,
        email: emailRow.email,
        expiresAt: verification.expiresAt,
        userId: authUser.id,
        verificationUrl,
      });

      return {
        developmentVerificationUrl:
          emailRuntimeConfig.mode === "dev-auto-verify" ? verificationUrl : null,
        verificationEmailSent: true,
      };
    },
  };
}

export const authService = createAuthService();

export type AuthService = ReturnType<typeof createAuthService>;
