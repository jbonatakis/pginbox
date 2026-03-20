import { describe, expect, it } from "bun:test";
import {
  toTrackedThread,
  toTrackedThreadCounts,
  toThreadProgress,
} from "../../src/server/serialize";

describe("thread tracking serialization", () => {
  it("serializes thread progress into the shared wire shape", () => {
    expect(
      toThreadProgress({
        threadId: "thread-1",
        isFollowed: true,
        isInMyThreads: false,
        isMyThreadsSuppressed: true,
        lastReadMessageId: 42n,
        firstUnreadMessageId: "43",
        unreadCount: 7,
        hasUnread: true,
        resumePage: 3,
        latestPage: 5,
      })
    ).toEqual({
      threadId: "thread-1",
      isFollowed: true,
      isInMyThreads: false,
      isMyThreadsSuppressed: true,
      lastReadMessageId: "42",
      firstUnreadMessageId: "43",
      unreadCount: 7,
      hasUnread: true,
      resumePage: 3,
      latestPage: 5,
    });
  });

  it("serializes tracked-thread rows and tab counts", () => {
    expect(
      toTrackedThread({
        id: "TTHREAD2",
        thread_id: "thread-2",
        list_id: 9,
        subject: "Subject",
        started_at: new Date("2026-03-16T10:00:00.000Z"),
        last_activity_at: "2026-03-17T11:00:00.000Z",
        message_count: 12,
        list_name: "pgsql-hackers",
        is_followed: true,
        is_in_my_threads: true,
        is_my_threads_suppressed: false,
        last_read_message_id: 100n,
        first_unread_message_id: 101n,
        unread_count: 2,
        has_unread: true,
        resume_page: 2,
        latest_page: 4,
      })
    ).toEqual({
      id: "TTHREAD2",
      thread_id: "thread-2",
      list_id: 9,
      subject: "Subject",
      started_at: "2026-03-16T10:00:00.000Z",
      last_activity_at: "2026-03-17T11:00:00.000Z",
      message_count: 12,
      list_name: "pgsql-hackers",
      is_followed: true,
      is_in_my_threads: true,
      is_my_threads_suppressed: false,
      last_read_message_id: "100",
      first_unread_message_id: "101",
      unread_count: 2,
      has_unread: true,
      resume_page: 2,
      latest_page: 4,
    });

    expect(
      toTrackedThreadCounts({
        followed_threads: "7",
        my_threads: 3n,
      })
    ).toEqual({
      followedThreads: 7,
      myThreads: 3,
    });
  });
});
