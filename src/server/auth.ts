import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import type { AuthUser } from "shared/api";
import { UserRole } from "./types/user";
import { toDbInt8 } from "./db-ids";
import { db as defaultDb } from "./db";
import { BadRequestError } from "./errors";
import type { DB } from "./types/db.d.ts";

export const SESSION_COOKIE_NAME = "pginbox_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_LAST_SEEN_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 200;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_ENCODER = new TextEncoder();
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$XMrTuaWDguTUpSvk6qZnAPvFBpp9MR2HKmwR8VmN2ms$nVLiWzOSjk0nEJLyC9Kz0r2mp6AU0UlfOvPuGYS34d8";

export interface AuthUserRecord {
  created_at: Date | string;
  display_name: string | null;
  email: string;
  email_verified_at: Date | string | null;
  id: bigint | number | string;
  role: string;
  status: AuthUser["status"];
}

export interface AuthSessionRecord {
  created_at: Date | string;
  expires_at: Date | string;
  id: bigint | number | string;
  ip_address: string | null;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  user_agent: string | null;
  user_id: bigint | number | string;
}

export interface SessionRequestMetadata {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ResponseCookieTarget {
  headers: Record<string, string | string[] | undefined>;
}

export interface ResolveCurrentSessionOptions {
  db?: Kysely<DB>;
  now?: Date;
  request: Request;
  set?: ResponseCookieTarget;
}

export interface ResolvedCurrentSession {
  clearSessionCookie: boolean;
  session: AuthSessionRecord | null;
  user: AuthUserRecord | null;
}

export interface AuthenticatedSession extends ResolvedCurrentSession {
  session: AuthSessionRecord;
  user: AuthUserRecord;
}

interface SessionLookupRow {
  created_at: Date | string;
  display_name: string | null;
  email: string;
  email_verified_at: Date | string | null;
  expires_at: Date | string;
  id: bigint | number | string;
  ip_address: string | null;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  role: string;
  session_token_hash: string;
  status: AuthUser["status"];
  user_agent: string | null;
  user_created_at: Date | string;
  user_id: bigint | number | string;
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

function isProductionCookieRequest(): boolean {
  return process.env.NODE_ENV === "production";
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function appendSetCookieHeader(target: ResponseCookieTarget, cookie: string): void {
  const current = target.headers["set-cookie"];

  if (!current) {
    target.headers["set-cookie"] = cookie;
    return;
  }

  if (Array.isArray(current)) {
    target.headers["set-cookie"] = [...current, cookie];
    return;
  }

  target.headers["set-cookie"] = [current, cookie];
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.path) parts.push(`Path=${options.path}`);
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");

  return parts.join("; ");
}

function parseCookieHeader(cookieHeader: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();

  if (!cookieHeader) return cookies;

  for (const segment of cookieHeader.split(";")) {
    const index = segment.indexOf("=");
    if (index === -1) continue;

    const name = segment.slice(0, index).trim();
    const rawValue = segment.slice(index + 1).trim();

    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }

  return cookies;
}

function isResolvedCurrentSession(
  value: ResolveCurrentSessionOptions | ResolvedCurrentSession
): value is ResolvedCurrentSession {
  return typeof value === "object" && value !== null && "clearSessionCookie" in value;
}

function invalidateResolvedSession(
  set: ResponseCookieTarget | undefined,
  now: Date
): ResolvedCurrentSession {
  if (set) clearSessionCookie(set, { now });

  return {
    clearSessionCookie: true,
    session: null,
    user: null,
  };
}

async function revokeSessionById(
  authDb: Kysely<DB>,
  sessionId: bigint | number | string,
  now: Date
): Promise<void> {
  await authDb
    .updateTable("auth_sessions")
    .set({ revoked_at: now })
    .where("id", "=", toDbInt8(sessionId))
    .where("revoked_at", "is", null)
    .execute();
}

async function revokeSessionsForUser(
  authDb: Kysely<DB>,
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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeDisplayName(displayName: string | null | undefined): string | null {
  const normalized = displayName?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function passwordByteLength(password: string): number {
  return PASSWORD_ENCODER.encode(password).length;
}

export function assertValidEmail(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestError("Email must be a valid email address");
  }
}

export function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }

  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) {
    throw new BadRequestError(`Password must be at most ${PASSWORD_MAX_BYTES} bytes long`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, passwordHash);
  } catch {
    return false;
  }
}

export async function runDummyPasswordVerification(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_PASSWORD_HASH);
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenHashMatches(token: string, tokenHash: string): boolean {
  try {
    const computedHash = Buffer.from(hashOpaqueToken(token), "hex");
    const storedHash = Buffer.from(tokenHash, "hex");

    if (computedHash.length !== storedHash.length) return false;

    return timingSafeEqual(computedHash, storedHash);
  } catch {
    return false;
  }
}

export function getSessionTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  const cookies = parseCookieHeader(cookieHeader);
  return cookies.get(SESSION_COOKIE_NAME) ?? null;
}

export function getSessionRequestMetadata(request: Request): SessionRequestMetadata {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const userAgent = request.headers.get("user-agent")?.trim() ?? "";

  let ipAddress = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!ipAddress) ipAddress = request.headers.get("x-real-ip")?.trim() ?? "";
  if (!ipAddress && forwardedFor) {
    ipAddress = forwardedFor.split(",")[0]?.trim() ?? "";
  }

  return {
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  };
}

export function createSessionCookieHeader(token: string, options: { now?: Date } = {}): string {
  const now = options.now ?? new Date();

  return serializeCookie(SESSION_COOKIE_NAME, token, {
    expires: new Date(now.getTime() + SESSION_TTL_MS),
    httpOnly: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    path: "/",
    sameSite: "Lax",
    secure: isProductionCookieRequest(),
  });
}

export function createClearSessionCookieHeader(options: { now?: Date } = {}): string {
  return serializeCookie(SESSION_COOKIE_NAME, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: isProductionCookieRequest(),
  });
}

export function setSessionCookie(
  target: ResponseCookieTarget,
  token: string,
  options: { now?: Date } = {}
): void {
  appendSetCookieHeader(target, createSessionCookieHeader(token, options));
}

export function clearSessionCookie(target: ResponseCookieTarget, options: { now?: Date } = {}): void {
  appendSetCookieHeader(target, createClearSessionCookieHeader(options));
}

export async function resolveCurrentSession(
  options: ResolveCurrentSessionOptions
): Promise<ResolvedCurrentSession> {
  const authDb = options.db ?? defaultDb;
  const now = options.now ?? new Date();
  const sessionToken = getSessionTokenFromRequest(options.request);

  if (sessionToken === null) {
    return {
      clearSessionCookie: false,
      session: null,
      user: null,
    };
  }

  if (!sessionToken) {
    return invalidateResolvedSession(options.set, now);
  }

  const tokenHash = hashOpaqueToken(sessionToken);
  const row = await authDb
    .selectFrom("auth_sessions")
    .innerJoin("users", "users.id", "auth_sessions.user_id")
    .select([
      "auth_sessions.id",
      "auth_sessions.user_id",
      "auth_sessions.created_at",
      "auth_sessions.last_seen_at",
      "auth_sessions.expires_at",
      "auth_sessions.revoked_at",
      "auth_sessions.ip_address",
      "auth_sessions.user_agent",
      "auth_sessions.token_hash as session_token_hash",
      "users.email",
      "users.display_name",
      "users.role",
      "users.status",
      "users.email_verified_at",
      "users.created_at as user_created_at",
    ])
    .where("auth_sessions.token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!row || !tokenHashMatches(sessionToken, row.session_token_hash)) {
    return invalidateResolvedSession(options.set, now);
  }

  const lookupRow = row as SessionLookupRow;
  const isExpired = toDate(lookupRow.expires_at).getTime() <= now.getTime();
  const isRevoked = lookupRow.revoked_at !== null;
  const isDisabled = lookupRow.status === "disabled";
  const isPending = lookupRow.status !== "active" || lookupRow.email_verified_at === null;

  if (isDisabled) {
    await revokeSessionsForUser(authDb, lookupRow.user_id, now);
    return invalidateResolvedSession(options.set, now);
  }

  if (isRevoked || isExpired || isPending) {
    if (!isRevoked) {
      await revokeSessionById(authDb, lookupRow.id, now);
    }

    return invalidateResolvedSession(options.set, now);
  }

  let lastSeenAt = lookupRow.last_seen_at;
  if (
    now.getTime() - toDate(lookupRow.last_seen_at).getTime() >=
    SESSION_LAST_SEEN_UPDATE_INTERVAL_MS
  ) {
    await authDb
      .updateTable("auth_sessions")
      .set({ last_seen_at: now })
      .where("id", "=", toDbInt8(lookupRow.id))
      .where("revoked_at", "is", null)
      .execute();

    lastSeenAt = now;
  }

  return {
    clearSessionCookie: false,
    session: {
      created_at: lookupRow.created_at,
      expires_at: lookupRow.expires_at,
      id: lookupRow.id,
      ip_address: lookupRow.ip_address,
      last_seen_at: lastSeenAt,
      revoked_at: lookupRow.revoked_at,
      user_agent: lookupRow.user_agent,
      user_id: lookupRow.user_id,
    },
    user: {
      created_at: lookupRow.user_created_at,
      display_name: lookupRow.display_name,
      email: lookupRow.email,
      email_verified_at: lookupRow.email_verified_at,
      id: lookupRow.user_id,
      role: lookupRow.role,
      status: lookupRow.status,
    },
  };
}

export async function requireAuth(
  input: ResolveCurrentSessionOptions | ResolvedCurrentSession
): Promise<AuthenticatedSession> {
  const resolved = isResolvedCurrentSession(input) ? input : await resolveCurrentSession(input);

  if (!resolved.user || !resolved.session) {
    throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
  }

  return resolved as AuthenticatedSession;
}

export async function requireAdminAuth(
  input: ResolveCurrentSessionOptions | ResolvedCurrentSession
): Promise<AuthenticatedSession> {
  const session = await requireAuth(input);

  if (session.user.role !== UserRole.Admin) {
    throw new AuthError(403, "ADMIN_REQUIRED", "Admin access required");
  }

  return session;
}
