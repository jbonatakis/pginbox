import type {
  AttachmentDetail,
  AttachmentSummary,
  AuthMeResponse,
  AuthMessageResponse,
  AuthRegisterResponse,
  AuthResendVerificationResponse,
  AuthUser,
  AuthUserResponse,
  List,
  Message,
  MessageWithAttachments,
  Person,
  TrackedThread,
  TrackedThreadCounts,
  ThreadDetail,
  ThreadProgress,
  ThreadMessagePagination,
  Thread,
  ThreadWithMessages,
} from "shared/api";

function dateToIso(d: Date | string | null | undefined): string | null {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
}

function bigintToString(v: bigint | number | string): string {
  return String(v);
}

function nullableBigintToString(v: bigint | number | string | null | undefined): string | null {
  return v == null ? null : bigintToString(v);
}

// Lists: already API-shaped (id number, name string)
export function toList(row: { id: number; name: string }): List {
  return { id: row.id, name: row.name };
}

// Auth user: bigint id -> string, timestamps -> ISO, internal fields omitted.
type AuthUserRow = {
  id: bigint | number | string;
  email: string;
  display_name: string | null;
  status: AuthUser["status"];
  email_verified_at: Date | string | null;
  created_at: Date | string;
};

export function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: bigintToString(row.id),
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    emailVerifiedAt: dateToIso(row.email_verified_at),
    createdAt: dateToIso(row.created_at)!,
  };
}

export function toAuthMeResponse(user: AuthUserRow | null | undefined): AuthMeResponse {
  return {
    user: user == null ? null : toAuthUser(user),
  };
}

export function toAuthUserResponse(user: AuthUserRow): AuthUserResponse {
  return {
    user: toAuthUser(user),
  };
}

export function toAuthMessageResponse(
  message: string,
  options: { developmentVerificationUrl?: string | null } = {}
): AuthMessageResponse | AuthRegisterResponse | AuthResendVerificationResponse {
  return {
    message,
    ...(options.developmentVerificationUrl
      ? { developmentVerificationUrl: options.developmentVerificationUrl }
      : {}),
  };
}

// Thread (list item): dates -> ISO strings
type ThreadRow = {
  thread_id: string;
  list_id: number;
  subject: string | null;
  started_at: Date | string | null;
  last_activity_at: Date | string | null;
  message_count: number;
  list_name: string;
  is_followed?: boolean | null;
};

export function toThread(row: ThreadRow): Thread {
  const thread: Thread = {
    thread_id: row.thread_id,
    list_id: row.list_id,
    subject: row.subject,
    started_at: dateToIso(row.started_at),
    last_activity_at: dateToIso(row.last_activity_at),
    message_count: row.message_count,
    list_name: row.list_name,
  };

  if (typeof row.is_followed === "boolean") {
    thread.is_followed = row.is_followed;
  }

  return thread;
}

type ThreadProgressRow = {
  threadId: string;
  isFollowed: boolean;
  isInMyThreads: boolean;
  isMyThreadsSuppressed: boolean;
  lastReadMessageId: bigint | number | string | null;
  firstUnreadMessageId: bigint | number | string | null;
  unreadCount: number;
  hasUnread: boolean;
  resumePage: number | null;
  latestPage: number;
};

export function toThreadProgress(row: ThreadProgressRow): ThreadProgress {
  return {
    threadId: row.threadId,
    isFollowed: row.isFollowed,
    isInMyThreads: row.isInMyThreads,
    isMyThreadsSuppressed: row.isMyThreadsSuppressed,
    lastReadMessageId: nullableBigintToString(row.lastReadMessageId),
    firstUnreadMessageId: nullableBigintToString(row.firstUnreadMessageId),
    unreadCount: row.unreadCount,
    hasUnread: row.hasUnread,
    resumePage: row.resumePage,
    latestPage: row.latestPage,
  };
}

type TrackedThreadRow = ThreadRow & {
  is_followed: boolean;
  is_in_my_threads: boolean;
  is_my_threads_suppressed: boolean;
  last_read_message_id: bigint | number | string | null;
  first_unread_message_id: bigint | number | string | null;
  unread_count: number;
  has_unread: boolean;
  resume_page: number | null;
  latest_page: number;
};

export function toTrackedThread(row: TrackedThreadRow): TrackedThread {
  return {
    ...toThread(row),
    is_followed: row.is_followed,
    is_in_my_threads: row.is_in_my_threads,
    is_my_threads_suppressed: row.is_my_threads_suppressed,
    last_read_message_id: nullableBigintToString(row.last_read_message_id),
    first_unread_message_id: nullableBigintToString(row.first_unread_message_id),
    unread_count: row.unread_count,
    has_unread: row.has_unread,
    resume_page: row.resume_page,
    latest_page: row.latest_page,
  };
}

type TrackedThreadCountsRow = {
  followed_threads: bigint | number | string;
  my_threads: bigint | number | string;
};

export function toTrackedThreadCounts(row: TrackedThreadCountsRow): TrackedThreadCounts {
  return {
    followedThreads: Number(row.followed_threads),
    myThreads: Number(row.my_threads),
  };
}

// Message: id and sent_at serialized
type MessageRow = {
  id: bigint | number | string;
  message_id: string;
  thread_id: string;
  list_id: number;
  sent_at: Date | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  in_reply_to: string | null;
  refs: string[] | null;
  body: string | null;
  sent_at_approx: boolean;
};

export function toMessage(row: MessageRow): Message {
  return {
    id: bigintToString(row.id),
    message_id: row.message_id,
    thread_id: row.thread_id,
    list_id: row.list_id,
    sent_at: dateToIso(row.sent_at),
    from_name: row.from_name,
    from_email: row.from_email,
    subject: row.subject,
    in_reply_to: row.in_reply_to,
    refs: row.refs,
    body: row.body,
    sent_at_approx: row.sent_at_approx,
  };
}

type AttachmentRow = {
  id: bigint | number | string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  has_content: boolean;
};

export function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: bigintToString(row.id),
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    has_content: row.has_content,
  };
}

type AttachmentDetailRow = AttachmentRow & {
  content: string | null;
};

export function toAttachmentDetail(row: AttachmentDetailRow): AttachmentDetail {
  return {
    ...toAttachmentSummary(row),
    content: row.content,
  };
}

export function toMessageWithAttachments(
  message: MessageRow,
  attachments: AttachmentRow[]
): MessageWithAttachments {
  return {
    ...toMessage(message),
    attachments: attachments.map(toAttachmentSummary),
  };
}

type MessageWithAttachmentsRow = MessageRow & {
  attachments: AttachmentRow[];
};

export function toThreadWithMessages(
  thread: ThreadRow,
  messages: MessageWithAttachmentsRow[]
): ThreadWithMessages {
  return {
    ...toThread(thread),
    messages: messages.map((message) => toMessageWithAttachments(message, message.attachments)),
  };
}

export function toThreadDetail(
  thread: ThreadRow,
  messages: MessageWithAttachmentsRow[],
  messagePagination: ThreadMessagePagination
): ThreadDetail {
  return {
    ...toThreadWithMessages(thread, messages),
    messagePagination,
  };
}

// Person detail: created_at and topThreads[].last_activity_at -> ISO
type PersonRow = {
  id: number;
  name: string;
  created_at: Date;
};
type PersonTopThreadRow = {
  thread_id: string;
  subject: string | null;
  last_activity_at: Date | null;
  message_count: number;
};

export function toPerson(
  person: PersonRow,
  emails: string[],
  topThreads: PersonTopThreadRow[]
): Person {
  return {
    id: person.id,
    name: person.name,
    created_at: dateToIso(person.created_at) ?? "",
    emails,
    topThreads: topThreads.map((t) => ({
      thread_id: t.thread_id,
      subject: t.subject,
      last_activity_at: dateToIso(t.last_activity_at),
      message_count: t.message_count,
    })) as Person["topThreads"],
  };
}
