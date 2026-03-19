import type { ThreadFollowState, ThreadProgress } from "shared/api";
import { threadDetailPath } from "../router";

type CountFormatter = (count: number) => string;

export interface ThreadResumeTarget {
  anchorId: string;
  targetPage: number;
  targetThreadId: string;
  targetUrl: string;
}

export interface ThreadDetailTrackingView {
  followButtonLabel: "Follow" | "Unfollow";
  isTracked: boolean;
  participationText: string;
  resumeTarget: ThreadResumeTarget | null;
  showAddBackToMyThreads: boolean;
  showMarkRead: boolean;
  showRemoveFromMyThreads: boolean;
  showResumeReading: boolean;
  statusText: string;
  timelineFirstUnreadMessageId: string | null;
  timelineThreadId: string;
  trackReadProgress: boolean;
}

export function hasActiveThreadTracking(
  progress:
    | Pick<ThreadProgress, "isFollowed" | "isInMyThreads">
    | Pick<ThreadFollowState, "isFollowed" | "isInMyThreads">
    | null
    | undefined
): boolean {
  return progress?.isFollowed === true || progress?.isInMyThreads === true;
}

export function getThreadResumeTarget(
  progress: Pick<
    ThreadProgress,
    "threadId" | "isFollowed" | "isInMyThreads" | "hasUnread" | "firstUnreadMessageId" | "resumePage" | "latestPage"
  >
): ThreadResumeTarget | null {
  if (!hasActiveThreadTracking(progress) || !progress.hasUnread || progress.firstUnreadMessageId === null) {
    return null;
  }

  const targetPage = progress.resumePage ?? progress.latestPage;
  const anchorId = `message-${progress.firstUnreadMessageId}`;
  const basePath = threadDetailPath(progress.threadId);

  return {
    anchorId,
    targetPage,
    targetThreadId: progress.threadId,
    targetUrl:
      targetPage < progress.latestPage
        ? `${basePath}?page=${targetPage}#${anchorId}`
        : `${basePath}#${anchorId}`,
  };
}

export function getThreadTrackingStatusText(
  progress: Pick<
    ThreadProgress,
    "isFollowed" | "isInMyThreads" | "isMyThreadsSuppressed" | "hasUnread" | "unreadCount"
  >,
  formatCount: CountFormatter = (count) => String(count)
): string {
  if (hasActiveThreadTracking(progress)) {
    if (!progress.hasUnread) {
      return "All caught up";
    }

    const countLabel = formatCount(progress.unreadCount);
    return `${countLabel} ${progress.unreadCount === 1 ? "unread message" : "unread messages"}`;
  }

  if (progress.isMyThreadsSuppressed) {
    return "Add back to My Threads or follow this thread to track unread messages.";
  }

  return "Follow this thread or reply to it to track unread messages.";
}

export function getThreadParticipationText(
  progress: Pick<ThreadProgress, "isFollowed" | "isInMyThreads" | "isMyThreadsSuppressed">
): string {
  if (progress.isMyThreadsSuppressed) {
    return "You replied in this thread but removed it from My Threads.";
  }

  if (progress.isInMyThreads && progress.isFollowed) {
    return "Tracked in My Threads because you replied. You are also following it manually.";
  }

  if (progress.isInMyThreads) {
    return "Tracked in My Threads because you replied.";
  }

  return "Not in My Threads yet. Replying in this thread will add it there automatically.";
}

export function getThreadDetailTrackingView(
  isAuthenticated: boolean,
  progress: ThreadProgress | null,
  formatCount: CountFormatter = (count) => String(count)
): ThreadDetailTrackingView | null {
  if (!isAuthenticated || progress === null) {
    return null;
  }

  const isTracked = hasActiveThreadTracking(progress);
  const resumeTarget = getThreadResumeTarget(progress);

  return {
    followButtonLabel: progress.isFollowed ? "Unfollow" : "Follow",
    isTracked,
    participationText: getThreadParticipationText(progress),
    resumeTarget,
    showAddBackToMyThreads: progress.isMyThreadsSuppressed,
    showMarkRead: isTracked && progress.hasUnread,
    showRemoveFromMyThreads: progress.isInMyThreads,
    showResumeReading: resumeTarget !== null,
    statusText: getThreadTrackingStatusText(progress, formatCount),
    timelineFirstUnreadMessageId: progress.firstUnreadMessageId,
    timelineThreadId: progress.threadId,
    trackReadProgress: isTracked,
  };
}

export function mergeThreadProgressTrackingState(
  current: ThreadProgress,
  nextState: ThreadFollowState
): ThreadProgress {
  const isTracked = hasActiveThreadTracking(nextState);

  return {
    ...current,
    ...nextState,
    firstUnreadMessageId: isTracked ? current.firstUnreadMessageId : null,
    hasUnread: isTracked ? current.hasUnread : false,
    lastReadMessageId: isTracked ? current.lastReadMessageId : null,
    resumePage: isTracked ? current.resumePage : null,
    unreadCount: isTracked ? current.unreadCount : 0,
  };
}
