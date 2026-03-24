import { DEFAULT_THREAD_MESSAGES_PAGE_SIZE } from "shared/api";
import type {
  AddEmailRequest,
  AddEmailResponse,
  AdminStats,
  AdminUser,
  AdminUserListResponse,
  AnalyticsAll,
  AttachmentDetail,
  AnalyticsSummary,
  AnalyticsMessagesLast24h,
  ListMessagesLast24h,
  AccountProfileUpdateRequest,
  AccountProfileUpdateResponse,
  AuthForgotPasswordRequest,
  AuthForgotPasswordResponse,
  AuthLoginErrorCode,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthMeResponse,
  AuthRegisterRequest,
  AuthRegisterResponse,
  AuthRequiredErrorCode,
  AuthResendVerificationRequest,
  AuthResendVerificationResponse,
  AuthResetPasswordRequest,
  AuthResetPasswordResponse,
  AuthVerifyEmailErrorCode,
  AuthVerifyEmailRequest,
  AuthVerifyEmailResponse,
  ByDow,
  ByHour,
  ByMonth,
  List,
  MessagePermalink,
  Paginated,
  Person,
  PersonListItem,
  RemoveEmailResponse,
  ResendEmailVerificationResponse,
  SetPrimaryEmailResponse,
  TrackedThread,
  TrackedThreadCounts,
  Thread,
  ThreadDetail,
  ThreadFollowState,
  ThreadFollowStatesRequest,
  ThreadFollowStatesResponse,
  ThreadProgress,
  TopSender,
  UserEmailsResponse,
} from "shared/api";

const API_BASE_PATH = "/api";
export const AUTH_REQUEST_CREDENTIALS: RequestCredentials = "same-origin";
const DEFAULT_PAGINATION_LIMIT = 25;
const MIN_PAGINATION_LIMIT = 1;
const MAX_PAGINATION_LIMIT = 100;

export const AUTH_API_ERROR_CODES = [
  "AUTH_REQUIRED",
  "ACCOUNT_DISABLED",
  "EMAIL_NOT_VERIFIED",
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "TOKEN_INVALID",
] as const satisfies ReadonlyArray<
  AuthRequiredErrorCode | AuthLoginErrorCode | AuthVerifyEmailErrorCode
>;

type QueryPrimitive = string | number | boolean | Date;
type QueryValue = QueryPrimitive | QueryPrimitive[] | null | undefined;
type QueryParams = Record<string, QueryValue>;

export type AuthApiErrorCode = (typeof AUTH_API_ERROR_CODES)[number];

export interface RequestOptions {
  body?: BodyInit | null;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
  method?: string;
  signal?: AbortSignal;
}

export interface ApiErrorShape {
  code: string | null;
  details: unknown;
  message: string;
  method: string;
  path: string;
  status: number;
}

export interface ListThreadsParams {
  cursor?: string;
  from?: string | Date;
  limit?: number;
  list?: string;
  q?: string;
  to?: string | Date;
}

export interface ListPeopleParams {
  cursor?: string;
  limit?: number;
}

export interface ListAdminUsersParams {
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface GetThreadParams {
  limit?: number;
  page?: number;
}

export class ApiClientError extends Error implements ApiErrorShape {
  readonly code: string | null;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(error: ApiErrorShape) {
    super(error.message);
    this.name = "ApiClientError";
    this.code = error.code;
    this.details = error.details;
    this.method = error.method;
    this.path = error.path;
    this.status = error.status;
  }

  toJSON(): ApiErrorShape {
    return {
      code: this.code,
      details: this.details,
      message: this.message,
      method: this.method,
      path: this.path,
      status: this.status,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function addQueryParam(searchParams: URLSearchParams, key: string, value: QueryPrimitive): void {
  if (value instanceof Date) {
    searchParams.append(key, value.toISOString());
    return;
  }
  searchParams.append(key, String(value));
}

export function serializeQuery(params?: QueryParams): string {
  if (!params) return "";
  const searchParams = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(params)) {
    if (rawValue === undefined || rawValue === null) continue;

    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        addQueryParam(searchParams, key, value);
      }
      continue;
    }

    addQueryParam(searchParams, key, rawValue);
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

function withApiBase(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_PATH}${normalizedPath}${serializeQuery(query)}`;
}

export function encodePathParam(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function clampThreadLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGINATION_LIMIT;
  return Math.max(MIN_PAGINATION_LIMIT, Math.min(MAX_PAGINATION_LIMIT, Math.trunc(limit)));
}

export function clampPeopleLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGINATION_LIMIT;
  return Math.max(MIN_PAGINATION_LIMIT, Math.min(MAX_PAGINATION_LIMIT, Math.trunc(limit)));
}

export function clampThreadMessageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_THREAD_MESSAGES_PAGE_SIZE;
  return Math.max(MIN_PAGINATION_LIMIT, Math.min(MAX_PAGINATION_LIMIT, Math.trunc(limit)));
}

function normalizeApiError(
  response: Response,
  body: unknown,
  method: string,
  path: string
): ApiErrorShape {
  const payload = isRecord(body) ? body : null;
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : response.statusText || `Request failed with status ${response.status}`;
  const code = typeof payload?.code === "string" ? payload.code : null;

  return {
    code,
    details: body,
    message,
    method,
    path,
    status: response.status,
  };
}

function normalizeTransportError(error: unknown, method: string, path: string): ApiErrorShape {
  if (error instanceof ApiClientError) return error.toJSON();

  const isAbort = error instanceof DOMException && error.name === "AbortError";
  return {
    code: isAbort ? "ABORTED" : "NETWORK_ERROR",
    details: error,
    message: isAbort ? "Request aborted" : "Network request failed",
    method,
    path,
    status: 0,
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
}

function withJsonBody(body: unknown, options: RequestOptions = {}): RequestOptions {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return {
    ...options,
    body: JSON.stringify(body),
    headers,
  };
}

export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  try {
    const response = await fetch(path, {
      body: options.body,
      credentials: options.credentials,
      headers,
      method,
      signal: options.signal,
    });

    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new ApiClientError(normalizeApiError(response, body, method, path));
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    throw new ApiClientError(normalizeTransportError(error, method, path));
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

export function isAuthApiErrorCode(code: string | null | undefined): code is AuthApiErrorCode {
  return (
    typeof code === "string" &&
    AUTH_API_ERROR_CODES.includes(code as AuthApiErrorCode)
  );
}

export function toApiErrorShape(error: unknown): ApiErrorShape {
  if (error instanceof ApiClientError) return error.toJSON();

  if (isRecord(error) && typeof error.message === "string" && typeof error.status === "number") {
    return {
      code: typeof error.code === "string" ? error.code : null,
      details: "details" in error ? error.details : error,
      message: error.message,
      method: typeof error.method === "string" ? error.method : "GET",
      path: typeof error.path === "string" ? error.path : "",
      status: error.status,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    details: error,
    message: "Unknown API error",
    method: "GET",
    path: "",
    status: 0,
  };
}

export function getAuthApiErrorCode(error: unknown): AuthApiErrorCode | null {
  const code = toApiErrorShape(error).code;
  return isAuthApiErrorCode(code) ? code : null;
}

function requestAuthJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return requestJson<T>(path, {
    ...options,
    credentials: AUTH_REQUEST_CREDENTIALS,
  });
}

function postAuthJson<TResponse>(
  path: string,
  body: unknown,
  options: RequestOptions = {}
): Promise<TResponse> {
  return requestAuthJson<TResponse>(
    path,
    withJsonBody(body, {
      ...options,
      method: "POST",
    })
  );
}

function patchAuthJson<TResponse>(
  path: string,
  body: unknown,
  options: RequestOptions = {}
): Promise<TResponse> {
  return requestAuthJson<TResponse>(
    path,
    withJsonBody(body, {
      ...options,
      method: "PATCH",
    })
  );
}

export async function getAuthMe(options: RequestOptions = {}): Promise<AuthMeResponse> {
  return requestAuthJson<AuthMeResponse>(withApiBase("/auth/me"), options);
}

export async function register(
  input: AuthRegisterRequest,
  options: RequestOptions = {}
): Promise<AuthRegisterResponse> {
  return postAuthJson<AuthRegisterResponse>(withApiBase("/auth/register"), input, options);
}

export async function resendVerification(
  input: AuthResendVerificationRequest,
  options: RequestOptions = {}
): Promise<AuthResendVerificationResponse> {
  return postAuthJson<AuthResendVerificationResponse>(
    withApiBase("/auth/resend-verification"),
    input,
    options
  );
}

export async function verifyEmail(
  input: AuthVerifyEmailRequest,
  options: RequestOptions = {}
): Promise<AuthVerifyEmailResponse> {
  return postAuthJson<AuthVerifyEmailResponse>(withApiBase("/auth/verify-email"), input, options);
}

export async function login(
  input: AuthLoginRequest,
  options: RequestOptions = {}
): Promise<AuthLoginResponse> {
  return postAuthJson<AuthLoginResponse>(withApiBase("/auth/login"), input, options);
}

export async function logout(options: RequestOptions = {}): Promise<void> {
  return requestAuthJson<void>(withApiBase("/auth/logout"), {
    ...options,
    method: "POST",
  });
}

export async function forgotPassword(
  input: AuthForgotPasswordRequest,
  options: RequestOptions = {}
): Promise<AuthForgotPasswordResponse> {
  return postAuthJson<AuthForgotPasswordResponse>(
    withApiBase("/auth/forgot-password"),
    input,
    options
  );
}

export async function resetPassword(
  input: AuthResetPasswordRequest,
  options: RequestOptions = {}
): Promise<AuthResetPasswordResponse> {
  return postAuthJson<AuthResetPasswordResponse>(
    withApiBase("/auth/reset-password"),
    input,
    options
  );
}

export async function updateAccountProfile(
  input: AccountProfileUpdateRequest,
  options: RequestOptions = {}
): Promise<AccountProfileUpdateResponse> {
  return patchAuthJson<AccountProfileUpdateResponse>(
    withApiBase("/account/profile"),
    input,
    options
  );
}

export async function listAccountEmails(
  options: RequestOptions = {}
): Promise<UserEmailsResponse> {
  return requestAuthJson<UserEmailsResponse>(withApiBase("/account/emails"), options);
}

export async function addAccountEmail(
  input: AddEmailRequest,
  options: RequestOptions = {}
): Promise<AddEmailResponse> {
  return postAuthJson<AddEmailResponse>(withApiBase("/account/emails"), input, options);
}

export async function makeAccountEmailPrimary(
  emailId: string,
  options: RequestOptions = {}
): Promise<SetPrimaryEmailResponse> {
  return postAuthJson<SetPrimaryEmailResponse>(
    withApiBase(`/account/emails/${encodePathParam(emailId)}/make-primary`),
    {},
    options
  );
}

export async function removeAccountEmail(
  emailId: string,
  options: RequestOptions = {}
): Promise<RemoveEmailResponse> {
  return requestAuthJson<RemoveEmailResponse>(
    withApiBase(`/account/emails/${encodePathParam(emailId)}`),
    { ...options, method: "DELETE" }
  );
}

export async function resendAccountEmailVerification(
  emailId: string,
  options: RequestOptions = {}
): Promise<ResendEmailVerificationResponse> {
  return postAuthJson<ResendEmailVerificationResponse>(
    withApiBase(`/account/emails/${encodePathParam(emailId)}/resend-verification`),
    {},
    options
  );
}

export async function listThreads(
  params: ListThreadsParams = {},
  options: RequestOptions = {}
): Promise<Paginated<Thread>> {
  const path = withApiBase("/threads", {
    cursor: params.cursor,
    from: params.from,
    limit: clampThreadLimit(params.limit),
    list: params.list,
    q: params.q,
    to: params.to,
  });
  return requestJson<Paginated<Thread>>(path, options);
}

export async function getThread(
  threadId: string,
  params: GetThreadParams = {},
  options: RequestOptions = {}
): Promise<ThreadDetail> {
  const path = withApiBase(`/threads/${encodePathParam(threadId)}`, {
    limit: clampThreadMessageLimit(params.limit),
    page: params.page,
  });
  return requestJson<ThreadDetail>(path, options);
}

export async function getMessagePermalink(
  messageId: string,
  options: RequestOptions = {}
): Promise<MessagePermalink> {
  return requestJson<MessagePermalink>(
    withApiBase(`/messages/${encodePathParam(messageId)}/permalink`),
    options
  );
}

export async function getAttachment(
  id: string | number,
  options: RequestOptions = {}
): Promise<AttachmentDetail> {
  return requestJson<AttachmentDetail>(withApiBase(`/attachments/${encodePathParam(id)}`), options);
}

export function attachmentDownloadPath(id: string | number): string {
  return withApiBase(`/attachments/${encodePathParam(id)}/download`);
}

export async function listLists(options: RequestOptions = {}): Promise<List[]> {
  return requestJson<List[]>(withApiBase("/lists"), options);
}

export async function listPeople(
  params: ListPeopleParams = {},
  options: RequestOptions = {}
): Promise<Paginated<PersonListItem>> {
  const path = withApiBase("/people", {
    cursor: params.cursor,
    limit: clampPeopleLimit(params.limit),
  });
  return requestJson<Paginated<PersonListItem>>(path, options);
}

export async function getPerson(id: number | string, options: RequestOptions = {}): Promise<Person> {
  const path = withApiBase(`/people/${encodePathParam(id)}`);
  return requestJson<Person>(path, options);
}

export interface GetAnalyticsParams {
  listIds?: number[];
}

export async function getAnalyticsSummary(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<AnalyticsSummary> {
  return requestJson<AnalyticsSummary>(
    withApiBase("/analytics/summary", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsByMonth(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<ByMonth[]> {
  return requestJson<ByMonth[]>(
    withApiBase("/analytics/by-month", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsTopSenders(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<TopSender[]> {
  return requestJson<TopSender[]>(
    withApiBase("/analytics/top-senders", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsByHour(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<ByHour[]> {
  return requestJson<ByHour[]>(
    withApiBase("/analytics/by-hour", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsByDow(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<ByDow[]> {
  return requestJson<ByDow[]>(
    withApiBase("/analytics/by-dow", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsAll(
  params: GetAnalyticsParams = {},
  options: RequestOptions = {}
): Promise<AnalyticsAll> {
  return requestJson<AnalyticsAll>(
    withApiBase("/analytics/all", { list: params.listIds }),
    options
  );
}

export async function getAnalyticsMessagesLast24h(
  options: RequestOptions = {}
): Promise<AnalyticsMessagesLast24h> {
  return requestJson<AnalyticsMessagesLast24h>(withApiBase("/analytics/messages-last-24h"), options);
}

export async function getAnalyticsMessagesLast24hByList(
  options: RequestOptions = {}
): Promise<ListMessagesLast24h[]> {
  return requestJson<ListMessagesLast24h[]>(withApiBase("/analytics/messages-last-24h-by-list"), options);
}

export interface GetThreadProgressParams {
  pageSize?: number;
}

export interface ListTrackedThreadsParams {
  limit?: number;
  cursor?: string;
}

export type ListFollowedThreadsParams = ListTrackedThreadsParams;

export async function followThread(
  threadId: string,
  seedLastReadMessageId?: string | null,
  options: RequestOptions = {}
): Promise<ThreadFollowState> {
  return postAuthJson<ThreadFollowState>(
    withApiBase(`/threads/${encodePathParam(threadId)}/follow`),
    seedLastReadMessageId != null ? { seedLastReadMessageId } : {},
    options
  );
}

export async function unfollowThread(
  threadId: string,
  options: RequestOptions = {}
): Promise<ThreadFollowState> {
  return requestAuthJson<ThreadFollowState>(
    withApiBase(`/threads/${encodePathParam(threadId)}/follow`),
    { ...options, method: "DELETE" }
  );
}

export async function removeThreadFromMyThreads(
  threadId: string,
  options: RequestOptions = {}
): Promise<ThreadFollowState> {
  return requestAuthJson<ThreadFollowState>(
    withApiBase(`/threads/${encodePathParam(threadId)}/my-thread`),
    { ...options, method: "DELETE" }
  );
}

export async function addThreadBackToMyThreads(
  threadId: string,
  options: RequestOptions = {}
): Promise<ThreadFollowState> {
  return postAuthJson<ThreadFollowState>(
    withApiBase(`/threads/${encodePathParam(threadId)}/my-thread`),
    {},
    options
  );
}

export async function getThreadProgress(
  threadId: string,
  params: GetThreadProgressParams = {},
  options: RequestOptions = {}
): Promise<ThreadProgress> {
  const path = withApiBase(`/threads/${encodePathParam(threadId)}/progress`, {
    pageSize: params.pageSize,
  });
  return requestAuthJson<ThreadProgress>(path, options);
}

export async function advanceThreadProgress(
  threadId: string,
  lastReadMessageId: string,
  options: RequestOptions = {}
): Promise<ThreadProgress> {
  return postAuthJson<ThreadProgress>(
    withApiBase(`/threads/${encodePathParam(threadId)}/progress`),
    { lastReadMessageId },
    options
  );
}

export async function markThreadRead(
  threadId: string,
  options: RequestOptions = {}
): Promise<ThreadProgress> {
  return postAuthJson<ThreadProgress>(
    withApiBase(`/threads/${encodePathParam(threadId)}/progress/mark-read`),
    {},
    options
  );
}

export async function listFollowedThreads(
  params: ListTrackedThreadsParams = {},
  options: RequestOptions = {}
): Promise<Paginated<TrackedThread>> {
  const path = withApiBase("/me/followed-threads", {
    limit: params.limit,
    cursor: params.cursor,
  });
  return requestAuthJson<Paginated<TrackedThread>>(path, options);
}

export async function listMyThreads(
  params: ListTrackedThreadsParams = {},
  options: RequestOptions = {}
): Promise<Paginated<TrackedThread>> {
  const path = withApiBase("/me/my-threads", {
    limit: params.limit,
    cursor: params.cursor,
  });
  return requestAuthJson<Paginated<TrackedThread>>(path, options);
}

export async function getTrackedThreadCounts(
  options: RequestOptions = {}
): Promise<TrackedThreadCounts> {
  return requestAuthJson<TrackedThreadCounts>(withApiBase("/me/tracked-thread-counts"), options);
}

export async function getThreadFollowStates(
  input: ThreadFollowStatesRequest,
  options: RequestOptions = {}
): Promise<ThreadFollowStatesResponse> {
  if (input.threadIds.length === 0) {
    return { states: {} };
  }

  return postAuthJson<ThreadFollowStatesResponse>(
    withApiBase("/me/thread-follow-states"),
    input,
    options
  );
}

export async function getAdminStats(options: RequestOptions = {}): Promise<AdminStats> {
  return requestAuthJson<AdminStats>(withApiBase("/admin/stats"), options);
}

export async function listAdminUsers(
  params: ListAdminUsersParams = {},
  options: RequestOptions = {}
): Promise<AdminUserListResponse> {
  const path = withApiBase("/admin/users", {
    q: params.q,
    cursor: params.cursor,
    limit: params.limit,
  });
  return requestAuthJson<AdminUserListResponse>(path, options);
}

export async function disableAdminUser(
  userId: string,
  reason: string,
  options: RequestOptions = {}
): Promise<AdminUser> {
  return postAuthJson<AdminUser>(withApiBase(`/admin/users/${encodePathParam(userId)}/disable`), { reason }, options);
}

export async function enableAdminUser(
  userId: string,
  options: RequestOptions = {}
): Promise<AdminUser> {
  return requestAuthJson<AdminUser>(
    withApiBase(`/admin/users/${encodePathParam(userId)}/enable`),
    { ...options, method: "POST" }
  );
}

export async function resetAdminUserPassword(
  userId: string,
  options: RequestOptions = {}
): Promise<{ message: string }> {
  return requestAuthJson<{ message: string }>(
    withApiBase(`/admin/users/${encodePathParam(userId)}/reset-password`),
    { ...options, method: "POST" }
  );
}

export async function setAdminUserRole(
  userId: string,
  role: string,
  options: RequestOptions = {}
): Promise<AdminUser> {
  return patchAuthJson<AdminUser>(
    withApiBase(`/admin/users/${encodePathParam(userId)}/role`),
    { role },
    options
  );
}

export const api = {
  admin: {
    disable: disableAdminUser,
    enable: enableAdminUser,
    getStats: getAdminStats,
    listUsers: listAdminUsers,
    resetPassword: resetAdminUserPassword,
    setRole: setAdminUserRole,
  },
  attachments: {
    get: getAttachment,
  },
  analytics: {
    getAll: getAnalyticsAll,
    getByDow: getAnalyticsByDow,
    getByHour: getAnalyticsByHour,
    getMessagesLast24h: getAnalyticsMessagesLast24h,
    getMessagesLast24hByList: getAnalyticsMessagesLast24hByList,
    getByMonth: getAnalyticsByMonth,
    getSummary: getAnalyticsSummary,
    getTopSenders: getAnalyticsTopSenders,
  },
  account: {
    addEmail: addAccountEmail,
    listEmails: listAccountEmails,
    makePrimaryEmail: makeAccountEmailPrimary,
    removeEmail: removeAccountEmail,
    resendEmailVerification: resendAccountEmailVerification,
    updateProfile: updateAccountProfile,
  },
  auth: {
    forgotPassword,
    getMe: getAuthMe,
    login,
    logout,
    register,
    resendVerification,
    resetPassword,
    verifyEmail,
  },
  lists: {
    list: listLists,
  },
  messages: {
    getPermalink: getMessagePermalink,
  },
  people: {
    get: getPerson,
    list: listPeople,
  },
  me: {
    followedThreads: listFollowedThreads,
    myThreads: listMyThreads,
    trackedThreadCounts: getTrackedThreadCounts,
    threadFollowStates: getThreadFollowStates,
  },
  threads: {
    addBackToMyThreads: addThreadBackToMyThreads,
    advanceProgress: advanceThreadProgress,
    follow: followThread,
    get: getThread,
    getProgress: getThreadProgress,
    list: listThreads,
    markRead: markThreadRead,
    removeFromMyThreads: removeThreadFromMyThreads,
    unfollow: unfollowThread,
  },
};
