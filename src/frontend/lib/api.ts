import type {
  AttachmentDetail,
  AnalyticsSummary,
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
  Paginated,
  Person,
  PersonListItem,
  Thread,
  ThreadDetail,
  TopSender,
} from "shared/api";

const API_BASE_PATH = "/api";
export const AUTH_REQUEST_CREDENTIALS: RequestCredentials = "same-origin";
const DEFAULT_PAGINATION_LIMIT = 25;
const DEFAULT_THREAD_MESSAGES_LIMIT = 50;
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
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_THREAD_MESSAGES_LIMIT;
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

export async function getAnalyticsSummary(
  options: RequestOptions = {}
): Promise<AnalyticsSummary> {
  return requestJson<AnalyticsSummary>(withApiBase("/analytics/summary"), options);
}

export async function getAnalyticsByMonth(options: RequestOptions = {}): Promise<ByMonth[]> {
  return requestJson<ByMonth[]>(withApiBase("/analytics/by-month"), options);
}

export async function getAnalyticsTopSenders(options: RequestOptions = {}): Promise<TopSender[]> {
  return requestJson<TopSender[]>(withApiBase("/analytics/top-senders"), options);
}

export async function getAnalyticsByHour(options: RequestOptions = {}): Promise<ByHour[]> {
  return requestJson<ByHour[]>(withApiBase("/analytics/by-hour"), options);
}

export async function getAnalyticsByDow(options: RequestOptions = {}): Promise<ByDow[]> {
  return requestJson<ByDow[]>(withApiBase("/analytics/by-dow"), options);
}

export const api = {
  attachments: {
    get: getAttachment,
  },
  analytics: {
    getByDow: getAnalyticsByDow,
    getByHour: getAnalyticsByHour,
    getByMonth: getAnalyticsByMonth,
    getSummary: getAnalyticsSummary,
    getTopSenders: getAnalyticsTopSenders,
  },
  account: {
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
  people: {
    get: getPerson,
    list: listPeople,
  },
  threads: {
    get: getThread,
    list: listThreads,
  },
};
