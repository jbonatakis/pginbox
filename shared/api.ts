/**
 * API contract types shared by backend and frontend.
 * JSON over the wire: dates as ISO strings, bigint ids as strings.
 */

// ---- Lists ----
export interface List {
  id: number;
  name: string;
}

// ---- Threads ----
export interface Thread {
  thread_id: string;
  list_id: number;
  subject: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  list_name: string;
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

// ---- Analytics ----
export interface AnalyticsSummary {
  totalMessages: number;
  totalThreads: number;
  uniqueSenders: number;
  monthsIngested: number;
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

// ---- Pagination ----
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
