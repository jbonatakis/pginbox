/**
 * API contract types shared by backend and frontend.
 * JSON over the wire: dates as ISO strings, bigint ids as strings.
 */

export const DEFAULT_THREAD_MESSAGES_PAGE_SIZE = 50;

// ---- Lists ----
export interface List {
  id: number;
  name: string;
}

// ---- Threads ----
export interface Thread {
  id: string;
  thread_id: string;
  list_id: number;
  subject: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  list_name: string;
  is_followed?: boolean;
}

export interface ThreadFollowStatesRequest {
  threadIds: string[];
}

export interface ThreadFollowStateSummary {
  isFollowed: boolean;
  isInMyThreads: boolean;
  isMyThreadsSuppressed: boolean;
}

export interface ThreadFollowStatesResponse {
  states: Record<string, ThreadFollowStateSummary>;
}

export interface Message {
  id: string;
  message_id: string;
  thread_id: string;
  list_id: number;
  sent_at: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  in_reply_to: string | null;
  refs: string[] | null;
  body: string | null;
  sent_at_approx: boolean;
}

export interface AttachmentSummary {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  has_content: boolean;
}

export interface AttachmentDetail extends AttachmentSummary {
  content: string | null;
}

export interface MessageWithAttachments extends Message {
  attachments: AttachmentSummary[];
}

export interface MessagePermalink {
  messageId: string;
  threadId: string;
  page: number;
  pageSize: number;
}

export interface ThreadWithMessages extends Thread {
  messages: MessageWithAttachments[];
}

export interface ThreadMessagePagination {
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ThreadDetail extends ThreadWithMessages {
  messagePagination: ThreadMessagePagination;
}

// ---- People ----
export interface PersonListItem {
  id: number;
  name: string;
  message_count: number;
}

export interface PersonTopThread {
  id: string;
  thread_id: string;
  subject: string | null;
  last_activity_at: string | null;
  message_count: number;
}

export interface Person {
  id: number;
  name: string;
  created_at: string;
  emails: string[];
  topThreads: PersonTopThread[];
}

// ---- Auth ----
export type AuthUserStatus = "pending_verification" | "active" | "disabled";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  status: AuthUserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface AuthEmailRequest {
  email: string;
}

export interface AuthLoginRequest {
  email: string;
  password: string;
}

export interface AuthRegisterRequest extends AuthLoginRequest {
  displayName?: string | null;
}

export interface AccountProfileUpdateRequest {
  displayName: string | null;
}

export interface AuthVerifyEmailRequest {
  token: string;
}

export interface AuthResetPasswordRequest {
  token: string;
  newPassword: string;
}

export type AuthResendVerificationRequest = AuthEmailRequest;
export type AuthForgotPasswordRequest = AuthEmailRequest;

export interface AuthMessageResponse {
  message: string;
}

export interface AuthMeResponse {
  user: AuthUser | null;
}

export interface AuthUserResponse {
  user: AuthUser;
}

export interface AuthRegisterResponse extends AuthMessageResponse {
  developmentVerificationUrl?: string;
}

export interface AuthResendVerificationResponse extends AuthMessageResponse {
  developmentVerificationUrl?: string;
}

export type AuthVerifyEmailResponse = AuthUserResponse;
export type AuthLoginResponse = AuthUserResponse;
export type AuthLogoutResponse = void;
export type AuthForgotPasswordResponse = AuthMessageResponse;
export type AuthResetPasswordResponse = AuthUserResponse;
export type AccountProfileUpdateResponse = AuthUserResponse;

export type AuthVerifyEmailErrorCode = "TOKEN_INVALID" | "TOKEN_EXPIRED";
export type AuthLoginErrorCode =
  | "INVALID_CREDENTIALS"
  | "EMAIL_NOT_VERIFIED"
  | "ACCOUNT_DISABLED";
export type AuthRequiredErrorCode = "AUTH_REQUIRED";

// ---- Analytics ----
export interface AnalyticsSummary {
  totalMessages: number;
  totalThreads: number;
  uniqueSenders: number;
  monthsIngested: number;
}

export interface AnalyticsMessagesLast24h {
  messages: number;
}

export interface ByMonth {
  year: number;
  month: number;
  messages: number;
}

export interface TopSender {
  name: string | null;
  email: string | null;
  count: number;
}

export interface ByHour {
  hour: number;
  messages: number;
}

export interface ByDow {
  dow: number;
  messages: number;
}

// ---- Tracked Threads ----
export interface ThreadFollowState {
  threadId: string;
  isFollowed: boolean;
  isInMyThreads: boolean;
  isMyThreadsSuppressed: boolean;
}

export interface ThreadProgress {
  threadId: string;
  isFollowed: boolean;
  isInMyThreads: boolean;
  isMyThreadsSuppressed: boolean;
  lastReadMessageId: string | null;
  firstUnreadMessageId: string | null;
  unreadCount: number;
  hasUnread: boolean;
  resumePage: number | null;
  latestPage: number;
}

export interface TrackedThread extends Thread {
  is_followed: boolean;
  is_in_my_threads: boolean;
  is_my_threads_suppressed: boolean;
  last_read_message_id: string | null;
  first_unread_message_id: string | null;
  unread_count: number;
  has_unread: boolean;
  resume_page: number | null;
  latest_page: number;
}

export type FollowedThread = TrackedThread;

export interface TrackedThreadCounts {
  followedThreads: number;
  myThreads: number;
}

// ---- Pagination ----
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
