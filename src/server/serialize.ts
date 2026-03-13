import type {
  AttachmentDetail,
  AttachmentSummary,
  List,
  Message,
  MessageWithAttachments,
  Person,
  PersonTopThread,
  ThreadDetail,
  ThreadMessagePagination,
  Thread,
  ThreadWithMessages,
} from "shared/api";

function dateToIso(d: Date | null | undefined): string | null {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
}

function bigintToString(v: bigint | number | string): string {
  return String(v);
}

// Lists: already API-shaped (id number, name string)
export function toList(row: { id: number; name: string }): List {
  return { id: row.id, name: row.name };
}

// Thread (list item): dates -> ISO strings
type ThreadRow = {
  thread_id: string;
  list_id: number;
  subject: string | null;
  started_at: Date | null;
  last_activity_at: Date | null;
  message_count: number;
  list_name: string;
};

export function toThread(row: ThreadRow): Thread {
  return {
    thread_id: row.thread_id,
    list_id: row.list_id,
    subject: row.subject,
    started_at: dateToIso(row.started_at),
    last_activity_at: dateToIso(row.last_activity_at),
    message_count: row.message_count,
    list_name: row.list_name,
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
