import { describe, expect, it } from "bun:test";
import type { ThreadFollowState, ThreadProgress } from "../../src/shared/api";
import {
  getThreadDetailTrackingView,
  mergeThreadProgressTrackingState,
} from "../../src/frontend/lib/threadDetailTracking";

function buildProgress(overrides: Partial<ThreadProgress> = {}): ThreadProgress {
  return {
    threadId: "pgsql/thread-1",
    isFollowed: false,
    isInMyThreads: false,
    isMyThreadsSuppressed: false,
    lastReadMessageId: "10",
    firstUnreadMessageId: null,
    unreadCount: 0,
    hasUnread: false,
    resumePage: null,
    latestPage: 4,
    ...overrides,
  };
}

function buildFollowState(overrides: Partial<ThreadFollowState> = {}): ThreadFollowState {
  return {
    threadId: "pgsql/thread-1",
    isFollowed: false,
    isInMyThreads: false,
    isMyThreadsSuppressed: false,
    ...overrides,
  };
}

describe("thread detail tracking helpers", () => {
  it("returns follow-only controls and shared resume state", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isFollowed: true,
        hasUnread: true,
        unreadCount: 3,
        firstUnreadMessageId: "11",
        resumePage: 2,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("3 unread messages");
    expect(view?.participationText).toBe(
      "Not in My Threads yet. Replying in this thread will add it there automatically."
    );
    expect(view?.followButtonLabel).toBe("Unfollow");
    expect(view?.showResumeReading).toBe(true);
    expect(view?.showMarkRead).toBe(true);
    expect(view?.showRemoveFromMyThreads).toBe(false);
    expect(view?.showAddBackToMyThreads).toBe(false);
    expect(view?.trackReadProgress).toBe(true);
    expect(view?.timelineFirstUnreadMessageId).toBe("11");
    expect(view?.resumeTarget).toEqual({
      anchorId: "message-11",
      targetPage: 2,
      targetThreadId: "pgsql/thread-1",
      targetUrl: "/threads/pgsql%2Fthread-1?page=2#message-11",
    });
  });

  it("keeps shared unread, mark-read, and unread-divider state for My Threads tracking without a manual follow", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isInMyThreads: true,
        hasUnread: true,
        unreadCount: 2,
        firstUnreadMessageId: "12",
        resumePage: 3,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("2 unread messages");
    expect(view?.participationText).toBe("Tracked in My Threads because you replied.");
    expect(view?.followButtonLabel).toBe("Follow");
    expect(view?.showResumeReading).toBe(true);
    expect(view?.showMarkRead).toBe(true);
    expect(view?.showRemoveFromMyThreads).toBe(true);
    expect(view?.showAddBackToMyThreads).toBe(false);
    expect(view?.trackReadProgress).toBe(true);
    expect(view?.timelineFirstUnreadMessageId).toBe("12");
    expect(view?.resumeTarget?.targetUrl).toBe("/threads/pgsql%2Fthread-1?page=3#message-12");
  });

  it("keeps latest-page resume targets canonical for My Threads participation", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isInMyThreads: true,
        hasUnread: true,
        unreadCount: 1,
        firstUnreadMessageId: "12",
        resumePage: 4,
        latestPage: 4,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("1 unread message");
    expect(view?.resumeTarget).toEqual({
      anchorId: "message-12",
      targetPage: 4,
      targetThreadId: "pgsql/thread-1",
      targetUrl: "/threads/pgsql%2Fthread-1#message-12",
    });
  });

  it("describes both tracking sources together when the thread is followed and in My Threads", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isFollowed: true,
        isInMyThreads: true,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("All caught up");
    expect(view?.participationText).toBe(
      "Tracked in My Threads because you replied. You are also following it manually."
    );
    expect(view?.followButtonLabel).toBe("Unfollow");
    expect(view?.showResumeReading).toBe(false);
    expect(view?.showMarkRead).toBe(false);
    expect(view?.showRemoveFromMyThreads).toBe(true);
    expect(view?.showAddBackToMyThreads).toBe(false);
    expect(view?.trackReadProgress).toBe(true);
  });

  it("shows suppressed participation state alongside manual follow tracking", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isFollowed: true,
        isMyThreadsSuppressed: true,
        hasUnread: true,
        unreadCount: 4,
        firstUnreadMessageId: "13",
        resumePage: 1,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("4 unread messages");
    expect(view?.participationText).toBe(
      "You replied in this thread but removed it from My Threads."
    );
    expect(view?.followButtonLabel).toBe("Unfollow");
    expect(view?.showResumeReading).toBe(true);
    expect(view?.showMarkRead).toBe(true);
    expect(view?.showRemoveFromMyThreads).toBe(false);
    expect(view?.showAddBackToMyThreads).toBe(true);
    expect(view?.trackReadProgress).toBe(true);
    expect(view?.timelineFirstUnreadMessageId).toBe("13");
  });

  it("shows add-back controls without unread tracking when participation is suppressed and no follow remains", () => {
    const view = getThreadDetailTrackingView(
      true,
      buildProgress({
        isMyThreadsSuppressed: true,
        lastReadMessageId: null,
        firstUnreadMessageId: null,
        unreadCount: 0,
        hasUnread: false,
        resumePage: null,
      })
    );

    expect(view).not.toBeNull();
    expect(view?.statusText).toBe("Add back to My Threads or follow this thread to track unread messages.");
    expect(view?.participationText).toBe(
      "You replied in this thread but removed it from My Threads."
    );
    expect(view?.followButtonLabel).toBe("Follow");
    expect(view?.showResumeReading).toBe(false);
    expect(view?.showMarkRead).toBe(false);
    expect(view?.showRemoveFromMyThreads).toBe(false);
    expect(view?.showAddBackToMyThreads).toBe(true);
    expect(view?.trackReadProgress).toBe(false);
    expect(view?.timelineFirstUnreadMessageId).toBeNull();
  });

  it("hides tracking controls for logged-out users", () => {
    const view = getThreadDetailTrackingView(
      false,
      buildProgress({
        isFollowed: true,
        isInMyThreads: true,
        hasUnread: true,
        unreadCount: 5,
        firstUnreadMessageId: "99",
      })
    );

    expect(view).toBeNull();
  });

  it("preserves unread progress when My Threads is removed from a manually followed thread", () => {
    const merged = mergeThreadProgressTrackingState(
      buildProgress({
        isFollowed: true,
        isInMyThreads: true,
        hasUnread: true,
        unreadCount: 4,
        firstUnreadMessageId: "41",
        resumePage: 2,
      }),
      buildFollowState({
        isFollowed: true,
        isInMyThreads: false,
        isMyThreadsSuppressed: true,
      })
    );

    expect(merged.isFollowed).toBe(true);
    expect(merged.isInMyThreads).toBe(false);
    expect(merged.isMyThreadsSuppressed).toBe(true);
    expect(merged.hasUnread).toBe(true);
    expect(merged.unreadCount).toBe(4);
    expect(merged.firstUnreadMessageId).toBe("41");
    expect(merged.resumePage).toBe(2);
  });

  it("clears unread progress when no tracking source remains active", () => {
    const merged = mergeThreadProgressTrackingState(
      buildProgress({
        isInMyThreads: true,
        hasUnread: true,
        unreadCount: 4,
        firstUnreadMessageId: "41",
        resumePage: 2,
      }),
      buildFollowState({
        isFollowed: false,
        isInMyThreads: false,
        isMyThreadsSuppressed: true,
      })
    );

    expect(merged.isFollowed).toBe(false);
    expect(merged.isInMyThreads).toBe(false);
    expect(merged.isMyThreadsSuppressed).toBe(true);
    expect(merged.hasUnread).toBe(false);
    expect(merged.unreadCount).toBe(0);
    expect(merged.firstUnreadMessageId).toBeNull();
    expect(merged.resumePage).toBeNull();
    expect(merged.lastReadMessageId).toBeNull();
  });
});
