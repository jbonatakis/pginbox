import { afterEach, describe, expect, it } from "bun:test";
import {
  advanceThreadProgress,
  addThreadBackToMyThreads,
  followThread,
  getTrackedThreadCounts,
  getThreadProgress,
  listFollowedThreads,
  listMyThreads,
  markThreadRead,
  removeThreadFromMyThreads,
  unfollowThread,
} from "../../src/frontend/lib/api";

const originalFetch = globalThis.fetch;

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Response | Promise<Response>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    status: init.status ?? 200,
  });
}

function installFetchStub(...handlers: FetchHandler[]) {
  const calls: Array<{
    init: RequestInit | undefined;
    url: string;
  }> = [];
  let handlerIndex = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      calls.push({ init, url });

      const handler = handlers[handlerIndex];
      handlerIndex += 1;

      if (!handler) {
        throw new Error(`Unexpected fetch call #${handlerIndex} for ${url}`);
      }

      return await handler(input, init);
    },
    writable: true,
  });

  return { calls };
}

function followState(
  overrides: Partial<{
    isFollowed: boolean;
    isInMyThreads: boolean;
    isMyThreadsSuppressed: boolean;
    threadId: string;
  }> = {}
) {
  return {
    threadId: "pgsql/foo bar",
    isFollowed: false,
    isInMyThreads: false,
    isMyThreadsSuppressed: false,
    ...overrides,
  };
}

function progressState(
  overrides: Partial<{
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
  }> = {}
) {
  return {
    threadId: "pgsql/foo bar",
    isFollowed: false,
    isInMyThreads: true,
    isMyThreadsSuppressed: false,
    lastReadMessageId: "10",
    firstUnreadMessageId: "11",
    unreadCount: 1,
    hasUnread: true,
    resumePage: 2,
    latestPage: 6,
    ...overrides,
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
    writable: true,
  });
});

describe("frontend tracked-thread api helpers", () => {
  it("lists followed and my threads with cursor pagination", async () => {
    const followedPage = {
      items: [
        {
          id: "TFOLLOWED1",
          thread_id: "followed-thread",
          list_id: 1,
          subject: "Followed",
          started_at: "2026-03-16T10:00:00.000Z",
          last_activity_at: "2026-03-17T10:00:00.000Z",
          message_count: 4,
          list_name: "pgsql-hackers",
          is_followed: true,
          is_in_my_threads: true,
          is_my_threads_suppressed: false,
          last_read_message_id: "10",
          first_unread_message_id: "11",
          unread_count: 1,
          has_unread: true,
          resume_page: 1,
          latest_page: 1,
        },
      ],
      nextCursor: "cursor-1",
    };
    const myThreadsPage = {
      items: [
        {
          id: "TMY1",
          thread_id: "my-thread",
          list_id: 1,
          subject: "Mine",
          started_at: "2026-03-15T10:00:00.000Z",
          last_activity_at: "2026-03-18T10:00:00.000Z",
          message_count: 9,
          list_name: "pgsql-general",
          is_followed: false,
          is_in_my_threads: true,
          is_my_threads_suppressed: false,
          last_read_message_id: "20",
          first_unread_message_id: "21",
          unread_count: 3,
          has_unread: true,
          resume_page: 1,
          latest_page: 1,
        },
      ],
      nextCursor: null,
    };

    const fetchStub = installFetchStub(
      async (_input, init) => {
        expect(init?.method).toBe("GET");
        expect(init?.credentials).toBe("same-origin");
        return jsonResponse(followedPage);
      },
      async (_input, init) => {
        expect(init?.method).toBe("GET");
        expect(init?.credentials).toBe("same-origin");
        return jsonResponse(myThreadsPage);
      }
    );

    await expect(listFollowedThreads({ limit: 40, cursor: "cursor-1" })).resolves.toEqual(followedPage);
    await expect(listMyThreads({ limit: 10, cursor: "cursor-2" })).resolves.toEqual(myThreadsPage);

    expect(fetchStub.calls[0]?.url).toBe("/api/me/followed-threads?limit=40&cursor=cursor-1");
    expect(fetchStub.calls[1]?.url).toBe("/api/me/my-threads?limit=10&cursor=cursor-2");
  });

  it("keeps follow and progress helpers on their existing routes while carrying My Threads fields", async () => {
    const threadId = "pgsql/foo bar";
    const followedState = followState({
      isFollowed: true,
      isInMyThreads: false,
    });
    const unfollowedState = followState({
      isFollowed: false,
      isInMyThreads: true,
    });
    const progress = progressState();
    const advancedProgress = progressState({
      isFollowed: true,
      lastReadMessageId: "21",
      firstUnreadMessageId: "22",
      unreadCount: 2,
      resumePage: 3,
    });
    const markedReadProgress = progressState({
      isInMyThreads: false,
      isMyThreadsSuppressed: true,
      firstUnreadMessageId: null,
      unreadCount: 0,
      hasUnread: false,
      resumePage: null,
    });

    const fetchStub = installFetchStub(
      async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBe(JSON.stringify({ seedLastReadMessageId: "20" }));
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/json");
        return jsonResponse(followedState);
      },
      async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBeUndefined();
        return jsonResponse(unfollowedState);
      },
      async (_input, init) => {
        expect(init?.method).toBe("GET");
        expect(init?.credentials).toBe("same-origin");
        return jsonResponse(progress);
      },
      async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBe(JSON.stringify({ lastReadMessageId: "21" }));
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/json");
        return jsonResponse(advancedProgress);
      },
      async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBe("{}");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/json");
        return jsonResponse(markedReadProgress);
      }
    );

    await expect(followThread(threadId, "20")).resolves.toEqual(followedState);
    await expect(unfollowThread(threadId)).resolves.toEqual(unfollowedState);
    await expect(getThreadProgress(threadId, { pageSize: 75 })).resolves.toEqual(progress);
    await expect(advanceThreadProgress(threadId, "21")).resolves.toEqual(advancedProgress);
    await expect(markThreadRead(threadId)).resolves.toEqual(markedReadProgress);

    expect(fetchStub.calls[0]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/follow");
    expect(fetchStub.calls[1]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/follow");
    expect(fetchStub.calls[2]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/progress?pageSize=75");
    expect(fetchStub.calls[3]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/progress");
    expect(fetchStub.calls[4]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/progress/mark-read");
  });

  it("fetches lightweight tracked-thread counts with auth credentials", async () => {
    const counts = {
      followedThreads: 5,
      myThreads: 8,
    };

    const fetchStub = installFetchStub(async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("same-origin");
      return jsonResponse(counts);
    });

    await expect(getTrackedThreadCounts()).resolves.toEqual(counts);
    expect(fetchStub.calls[0]?.url).toBe("/api/me/tracked-thread-counts");
  });

  it("uses the my-thread routes for suppression remove and add-back actions", async () => {
    const threadId = "pgsql/foo bar";
    const removedState = {
      threadId,
      isFollowed: true,
      isInMyThreads: false,
      isMyThreadsSuppressed: true,
    };
    const restoredState = {
      threadId,
      isFollowed: true,
      isInMyThreads: true,
      isMyThreadsSuppressed: false,
    };

    const fetchStub = installFetchStub(
      async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBeUndefined();
        return jsonResponse(removedState);
      },
      async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBe("{}");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/json");
        return jsonResponse(restoredState);
      }
    );

    await expect(removeThreadFromMyThreads(threadId)).resolves.toEqual(removedState);
    await expect(addThreadBackToMyThreads(threadId)).resolves.toEqual(restoredState);

    expect(fetchStub.calls[0]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/my-thread");
    expect(fetchStub.calls[1]?.url).toBe("/api/threads/pgsql%2Ffoo%20bar/my-thread");
  });
});
