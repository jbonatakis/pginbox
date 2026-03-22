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
  claim_kind: UserEmailClaimKind;
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
  id: string;
  email: string;
  is_primary: boolean;
  verified_at: Date | string | null;
  created_at: Date | string;
}

type UserEmailClaimKind = "registration" | "secondary_addition";

interface UserEmailClaimRow {
  claim_kind: UserEmailClaimKind;
  created_at: Date | string;
  email: string;
  id: bigint | number | string;
  user_id: bigint | number | string;
}

interface RegistrationClaimRow {
  claim_id: bigint | number | string;
  email: string;
  user_created_at: Date | string;
  user_display_name: string | null;
  user_id: bigint | number | string;
  user_role: string;
  user_status: AuthUserRecord["status"];
}

interface VerifiedUserEmailRow {
  created_at: Date | string;
  email: string;
  id: bigint | number | string;
  is_primary: boolean;
  user_id: bigint | number | string;
  verified_at: Date | string;
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

const VERIFIED_EMAIL_ID_PREFIX = "email";
const EMAIL_CLAIM_ID_PREFIX = "claim";

function encodeUserEmailRecordId(
  kind: typeof VERIFIED_EMAIL_ID_PREFIX | typeof EMAIL_CLAIM_ID_PREFIX,
  id: bigint | number | string
): string {
  return `${kind}:${id}`;
}

function parseUserEmailRecordId(
  rawId: bigint | number | string
): { id: string; kind: typeof VERIFIED_EMAIL_ID_PREFIX | typeof EMAIL_CLAIM_ID_PREFIX } | null {
  const value = String(rawId).trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    return { id: value, kind: VERIFIED_EMAIL_ID_PREFIX };
  }

  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) return null;

  const kind = value.slice(0, separatorIndex);
  const id = value.slice(separatorIndex + 1);
  if (!id || !/^\d+$/.test(id)) return null;
  if (kind !== VERIFIED_EMAIL_ID_PREFIX && kind !== EMAIL_CLAIM_ID_PREFIX) return null;

  return {
    id,
    kind,
  };
}

async function findVerifiedEmailByEmail(
  authDb: DatabaseClient,
  email: string
): Promise<VerifiedUserEmailRow | null> {
  const row = await (authDb as any)
    .selectFrom("user_emails")
    .select(["id", "user_id", "email", "is_primary", "verified_at", "created_at"])
    .where("email", "=", email)
    .executeTakeFirst();

  return (row as VerifiedUserEmailRow | undefined) ?? null;
}

async function findRegistrationClaimByEmail(
  authDb: DatabaseClient,
  email: string
): Promise<RegistrationClaimRow | null> {
  const row = await (authDb as any)
    .selectFrom("user_email_claims as claim")
    .innerJoin("users", "users.id", "claim.user_id")
    .select([
      "claim.id as claim_id",
      "claim.email",
      "users.id as user_id",
      "users.display_name as user_display_name",
      "users.role as user_role",
      "users.status as user_status",
      "users.created_at as user_created_at",
    ])
    .where("claim.email", "=", email)
    .where("claim.claim_kind", "=", "registration")
    .executeTakeFirst();

  return (row as RegistrationClaimRow | undefined) ?? null;
}

async function findUserEmailClaimByUserAndEmail(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  email: string
): Promise<UserEmailClaimRow | null> {
  const row = await (authDb as any)
    .selectFrom("user_email_claims")
    .select(["id", "user_id", "email", "claim_kind", "created_at"])
    .where("user_id", "=", toDbInt8(userId))
    .where("email", "=", email)
    .executeTakeFirst();

  return (row as UserEmailClaimRow | undefined) ?? null;
}

async function findOwnedVerifiedEmailById(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  emailId: bigint | number | string
): Promise<VerifiedUserEmailRow | null> {
  const row = await (authDb as any)
    .selectFrom("user_emails")
    .select(["id", "user_id", "email", "is_primary", "verified_at", "created_at"])
    .where("id", "=", toDbInt8(emailId))
    .where("user_id", "=", toDbInt8(userId))
    .executeTakeFirst();

  return (row as VerifiedUserEmailRow | undefined) ?? null;
}

async function findOwnedEmailClaimById(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  claimId: bigint | number | string
): Promise<UserEmailClaimRow | null> {
  const row = await (authDb as any)
    .selectFrom("user_email_claims")
    .select(["id", "user_id", "email", "claim_kind", "created_at"])
    .where("id", "=", toDbInt8(claimId))
    .where("user_id", "=", toDbInt8(userId))
    .executeTakeFirst();

  return (row as UserEmailClaimRow | undefined) ?? null;
}

async function findPendingRegistrationUserByEmail(
  authDb: DatabaseClient,
  email: string
): Promise<UserCredentialsRow | null> {
  const row = await (authDb as any)
    .selectFrom("users")
    .innerJoin("user_email_claims as claim", (join: any) =>
      join.onRef("claim.user_id", "=", "users.id")
          .on("claim.email", "=", email)
          .on("claim.claim_kind", "=", "registration")
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
      "claim.email as email",
    ])
    .executeTakeFirst();

  if (!row) return null;

  return {
    ...(row as Omit<UserCredentialsRow, "email_verified_at">),
    email_verified_at: null,
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

async function consumeVerificationTokensForEmail(
  authDb: DatabaseClient,
  userId: bigint | number | string,
  email: string,
  now: Date
): Promise<void> {
  await authDb
    .updateTable("email_verification_tokens")
    .set({ consumed_at: now })
    .where("user_id", "=", toDbInt8(userId))
    .where("email", "=", email)
    .where("consumed_at", "is", null)
    .execute();
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
  const row = await (authDb as any)
    .selectFrom("email_verification_tokens")
    .innerJoin("users", "users.id", "email_verification_tokens.user_id")
    .innerJoin("user_email_claims as claim", (join: any) =>
      join.onRef("claim.user_id", "=", "email_verification_tokens.user_id")
          .onRef("claim.email", "=", "email_verification_tokens.email")
    )
    .select([
      "email_verification_tokens.email",
      "email_verification_tokens.token_hash",
      "email_verification_tokens.expires_at",
      "email_verification_tokens.consumed_at",
      "users.id as user_id",
      "users.status as user_status",
      "claim.claim_kind",
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

      const passwordHash = await hashPassword(input.password);
      const currentTime = now();

      const result = await authDb.transaction().execute(async (trx) => {
        const existingVerifiedEmail = await findVerifiedEmailByEmail(trx, email);
        if (existingVerifiedEmail) {
          return { user: null, verification: null };
        }

        const registrationClaim = await findRegistrationClaimByEmail(trx, email);
        if (!registrationClaim) {
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
            .insertInto("user_email_claims")
            .values({
              user_id: insertedUser.id,
              email,
              claim_kind: "registration",
              created_at: currentTime,
            })
            .execute();

          const user = toAuthUserRecord({ ...insertedUser, email, email_verified_at: null });
          const verification = await rotateVerificationToken(trx, insertedUser.id, email, currentTime);
          return { user, verification };
        }

        if (registrationClaim.user_status !== "pending_verification") {
          return { user: null, verification: null };
        }

        const updatedUser = await trx
          .updateTable("users")
          .set({
            display_name:
              hasDisplayNameOverride(input) ? displayName : registrationClaim.user_display_name,
            password_hash: passwordHash,
          })
          .where("id", "=", toDbInt8(registrationClaim.user_id))
          .returning(["id", "display_name", "role", "status", "created_at"])
          .executeTakeFirstOrThrow();

        const user = toAuthUserRecord({ ...updatedUser, email, email_verified_at: null });
        const verification = await rotateVerificationToken(trx, registrationClaim.user_id, email, currentTime);
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

      const registrationClaim = await findRegistrationClaimByEmail(authDb, email);
      if (!registrationClaim || registrationClaim.user_status !== "pending_verification") {
        return {
          developmentVerificationUrl: null,
          user: null,
          verificationEmailSent: false,
        };
      }

      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, registrationClaim.user_id, email, currentTime);
      });

      const authUser = toAuthUserRecord({
        id: registrationClaim.user_id,
        display_name: registrationClaim.user_display_name,
        role: registrationClaim.user_role,
        status: registrationClaim.user_status,
        created_at: registrationClaim.user_created_at,
        email,
        email_verified_at: null,
      });
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

        await consumeVerificationTokensForEmail(trx, tokenRecord.user_id, tokenRecord.email, currentTime);

        const isRegistration = tokenRecord.claim_kind === "registration";
        const existingVerifiedEmail = await findVerifiedEmailByEmail(trx, tokenRecord.email);

        if (
          existingVerifiedEmail &&
          String(existingVerifiedEmail.user_id) !== String(tokenRecord.user_id)
        ) {
          await (trx as any)
            .deleteFrom("user_email_claims")
            .where("email", "=", tokenRecord.email)
            .execute();
          throwInvalidToken();
        }

        if (!existingVerifiedEmail) {
          await (trx as any)
            .insertInto("user_emails")
            .values({
              user_id: toDbInt8(tokenRecord.user_id),
              email: tokenRecord.email,
              is_primary: isRegistration,
              verified_at: currentTime,
              created_at: currentTime,
            })
            .execute();
        } else if (isRegistration && !existingVerifiedEmail.is_primary) {
          await (trx as any)
            .updateTable("user_emails")
            .set({ is_primary: false })
            .where("user_id", "=", toDbInt8(tokenRecord.user_id))
            .where("is_primary", "=", true)
            .execute();

          await (trx as any)
            .updateTable("user_emails")
            .set({ is_primary: true })
            .where("id", "=", toDbInt8(existingVerifiedEmail.id))
            .execute();
        }

        if (isRegistration) {
          await trx
            .updateTable("users")
            .set({ status: "active" })
            .where("id", "=", toDbInt8(tokenRecord.user_id))
            .execute();
        }

        await (trx as any)
          .deleteFrom("user_email_claims")
          .where("email", "=", tokenRecord.email)
          .execute();

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
      const user = isValid
        ? await findUserByPrimaryEmail(authDb, email) ?? await findPendingRegistrationUserByEmail(authDb, email)
        : null;

      if (!user) {
        await runDummyPasswordVerification(password);
        throwInvalidCredentials();
      }

      const passwordMatches = await verifyPassword(password, user.password_hash);
      if (!passwordMatches) {
        throwInvalidCredentials();
      }

      if (user.status === "disabled") {
        await revokeAllSessionsForUser(authDb, user.id, now());
        throw new AuthError(403, "ACCOUNT_DISABLED", "This account is disabled");
      }

      if (user.status !== "active" || user.email_verified_at === null) {
        throw new AuthError(403, "EMAIL_NOT_VERIFIED", "Email verification is required");
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
      const [verifiedRows, claimRows] = await Promise.all([
        (authDb as any)
          .selectFrom("user_emails")
          .select(["id", "email", "is_primary", "verified_at", "created_at"])
          .where("user_id", "=", toDbInt8(userId))
          .execute() as Promise<VerifiedUserEmailRow[]>,
        (authDb as any)
          .selectFrom("user_email_claims")
          .select(["id", "email", "claim_kind", "created_at"])
          .where("user_id", "=", toDbInt8(userId))
          .where("claim_kind", "=", "secondary_addition")
          .execute() as Promise<Array<Pick<UserEmailClaimRow, "id" | "email" | "claim_kind" | "created_at">>>,
      ]);

      return [
        ...verifiedRows.map((row) => ({
          id: encodeUserEmailRecordId(VERIFIED_EMAIL_ID_PREFIX, row.id),
          email: row.email,
          is_primary: row.is_primary,
          verified_at: row.verified_at,
          created_at: row.created_at,
        })),
        ...claimRows.map((row) => ({
          id: encodeUserEmailRecordId(EMAIL_CLAIM_ID_PREFIX, row.id),
          email: row.email,
          is_primary: false,
          verified_at: null,
          created_at: row.created_at,
        })),
      ].sort((left, right) => {
        if (left.is_primary !== right.is_primary) {
          return left.is_primary ? -1 : 1;
        }

        const leftVerified = left.verified_at !== null;
        const rightVerified = right.verified_at !== null;
        if (leftVerified !== rightVerified) {
          return leftVerified ? -1 : 1;
        }

        const createdAtDiff = toDate(left.created_at).getTime() - toDate(right.created_at).getTime();
        if (createdAtDiff !== 0) {
          return createdAtDiff;
        }

        return left.email.localeCompare(right.email);
      });
    },

    async addEmail(
      userId: bigint | number | string,
      email: string
    ): Promise<AddEmailResult> {
      const normalizedEmail = normalizeEmail(email);
      assertValidEmail(normalizedEmail);

      const user = await findUserWithPrimaryEmailById(authDb, userId);
      if (!user) {
        throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      }

      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        const existingVerifiedEmail = await findVerifiedEmailByEmail(trx, normalizedEmail);
        if (existingVerifiedEmail) {
          return null;
        }

        const existingClaim = await findUserEmailClaimByUserAndEmail(trx, userId, normalizedEmail);
        if (!existingClaim) {
          await (trx as any)
            .insertInto("user_email_claims")
            .values({
              user_id: toDbInt8(userId),
              email: normalizedEmail,
              claim_kind: "secondary_addition",
              created_at: currentTime,
            })
            .execute();
        } else if (existingClaim.claim_kind !== "secondary_addition") {
          return null;
        }

        return rotateVerificationToken(trx, userId, normalizedEmail, currentTime);
      });

      if (!verification) {
        return { developmentVerificationUrl: null, verificationEmailSent: false };
      }

      const authUser = toAuthUserRecord(user);

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
      const parsedEmailId = parseUserEmailRecordId(emailId);
      if (!parsedEmailId) {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      if (parsedEmailId.kind === EMAIL_CLAIM_ID_PREFIX) {
        const emailClaim = await findOwnedEmailClaimById(authDb, userId, parsedEmailId.id);
        if (!emailClaim) {
          throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
        }

        throw new AuthError(400, "EMAIL_NOT_VERIFIED", "Only verified emails can be set as primary");
      }

      const emailRow = await findOwnedVerifiedEmailById(authDb, userId, parsedEmailId.id);

      if (!emailRow) {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      if (emailRow.is_primary) {
        return;
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
          .where("id", "=", toDbInt8(parsedEmailId.id))
          .execute();
      });
    },

    async removeEmail(
      userId: bigint | number | string,
      emailId: bigint | number | string
    ): Promise<void> {
      const parsedEmailId = parseUserEmailRecordId(emailId);
      if (!parsedEmailId) {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      if (parsedEmailId.kind === VERIFIED_EMAIL_ID_PREFIX) {
        const emailRow = await findOwnedVerifiedEmailById(authDb, userId, parsedEmailId.id);
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
          .where("id", "=", toDbInt8(parsedEmailId.id))
          .execute();

        return;
      }

      const emailClaim = await findOwnedEmailClaimById(authDb, userId, parsedEmailId.id);
      if (!emailClaim || emailClaim.claim_kind !== "secondary_addition") {
        throw new AuthError(404, "EMAIL_NOT_FOUND", "Email not found");
      }

      await (authDb as any)
        .deleteFrom("user_email_claims")
        .where("id", "=", toDbInt8(parsedEmailId.id))
        .execute();
    },

    async resendVerificationForEmail(
      userId: bigint | number | string,
      emailId: bigint | number | string
    ): Promise<AddEmailResult> {
      const parsedEmailId = parseUserEmailRecordId(emailId);
      if (!parsedEmailId || parsedEmailId.kind !== EMAIL_CLAIM_ID_PREFIX) {
        return { developmentVerificationUrl: null, verificationEmailSent: false };
      }

      const emailClaim = await findOwnedEmailClaimById(authDb, userId, parsedEmailId.id);
      if (!emailClaim || emailClaim.claim_kind !== "secondary_addition") {
        return { developmentVerificationUrl: null, verificationEmailSent: false };
      }

      const user = await findUserWithPrimaryEmailById(authDb, userId);
      if (!user) {
        throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      }

      const authUser = toAuthUserRecord(user);
      const currentTime = now();
      const verification = await authDb.transaction().execute(async (trx) => {
        return rotateVerificationToken(trx, userId, emailClaim.email, currentTime);
      });

      const verificationUrl = buildFrontendUrl(appBaseUrl, "/verify-email", verification.token);
      await mailer.sendVerificationEmail({
        displayName: authUser.display_name,
        email: emailClaim.email,
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
