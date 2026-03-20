import { describe, expect, it } from "bun:test";
import type { Paginated, TrackedThread, TrackedThreadCounts } from "../../src/shared/api";
import {
  createTrackedThreadTabsController,
  getDefaultTrackedThreadTab,
  getTrackedThreadEmptyMessage,
  getTrackedThreadErrorTitle,
  getTrackedThreadLatestUrl,
  getTrackedThreadLoadingCopy,
  getTrackedThreadResumeUrl,
  getTrackedThreadTabLabel,
} from "../../src/frontend/lib/trackedThreads";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function readState<T>(store: { subscribe: (run: (value: T) => void) => () => void }): T {
  let snapshot!: T;
  const unsubscribe = store.subscribe((value) => {
    snapshot = value;
  });
  unsubscribe();
  return snapshot;
}

function trackedThread(
  threadId: string,
  overrides: Partial<TrackedThread> = {}
): TrackedThread {
  return {
    id: `stable-${threadId}`,
    thread_id: threadId,
    list_id: 1,
    subject: `Thread ${threadId}`,
    started_at: "2026-03-17T09:00:00.000Z",
    last_activity_at: "2026-03-18T09:00:00.000Z",
    message_count: 5,
    list_name: "pgsql-hackers",
    is_followed: true,
    is_in_my_threads: true,
    is_my_threads_suppressed: false,
    last_read_message_id: "10",
    first_unread_message_id: null,
    unread_count: 0,
    has_unread: false,
    resume_page: null,
    latest_page: 4,
    ...overrides,
  };
}

function page(items: TrackedThread[], nextCursor: string | null): Paginated<TrackedThread> {
  return { items, nextCursor };
}

function apiError(message: string, status = 500) {
  return {
    code: "TEST_ERROR",
    details: null,
    message,
    method: "GET",
    path: "/api/test",
    status,
  };
}

describe("tracked-thread frontend helpers", () => {
  it("formats tab labels, picks the default tab, and preserves resume/latest URLs", () => {
    const unreadThread = trackedThread("pgsql/foo bar", {
      first_unread_message_id: "11",
      has_unread: true,
      resume_page: 2,
      unread_count: 3,
    });
    const readThread = trackedThread("pgsql/foo bar");

    expect(getTrackedThreadTabLabel("followed", 5)).toBe("Followed Threads (5)");
    expect(getTrackedThreadTabLabel("my", 8)).toBe("My Threads (8)");
    expect(
      getDefaultTrackedThreadTab({
        followedThreads: 0,
        myThreads: 4,
      } satisfies TrackedThreadCounts)
    ).toBe("my");
    expect(
      getDefaultTrackedThreadTab({
        followedThreads: 2,
        myThreads: 4,
      } satisfies TrackedThreadCounts)
    ).toBe("followed");
    expect(getTrackedThreadResumeUrl(unreadThread)).toBe(
      "/threads/pgsql%2Ffoo%20bar?page=2#message-11"
    );
    expect(getTrackedThreadResumeUrl(readThread)).toBe("/threads/pgsql%2Ffoo%20bar?page=4");
    expect(getTrackedThreadLatestUrl(readThread)).toBe("/threads/pgsql%2Ffoo%20bar");
  });

  it("exposes account-page copy and shares unread resume links across followed and My Threads rows", () => {
    const followedUnreadThread = trackedThread("pgsql/foo bar", {
      is_followed: true,
      is_in_my_threads: false,
      first_unread_message_id: "11",
      has_unread: true,
      resume_page: 2,
      unread_count: 3,
    });
    const myUnreadThread = trackedThread("pgsql/foo bar", {
      is_followed: false,
      is_in_my_threads: true,
      first_unread_message_id: "11",
      has_unread: true,
      resume_page: 2,
      unread_count: 3,
    });
    const myCaughtUpThread = trackedThread("pgsql/foo bar", {
      is_followed: false,
      is_in_my_threads: true,
      latest_page: 6,
    });

    expect(getTrackedThreadEmptyMessage("followed")).toBe("No followed threads yet.");
    expect(getTrackedThreadEmptyMessage("my")).toBe("No threads in My Threads yet.");
    expect(getTrackedThreadLoadingCopy("followed")).toEqual({
      message: "Fetching your followed threads.",
      title: "Loading followed threads",
    });
    expect(getTrackedThreadLoadingCopy("my")).toEqual({
      message: "Fetching threads you started or replied to.",
      title: "Loading My Threads",
    });
    expect(getTrackedThreadErrorTitle("followed")).toBe("Unable to load followed threads");
    expect(getTrackedThreadErrorTitle("my")).toBe("Unable to load My Threads");
    expect(getTrackedThreadResumeUrl(followedUnreadThread)).toBe(
      "/threads/pgsql%2Ffoo%20bar?page=2#message-11"
    );
    expect(getTrackedThreadResumeUrl(myUnreadThread)).toBe(
      "/threads/pgsql%2Ffoo%20bar?page=2#message-11"
    );
    expect(getTrackedThreadResumeUrl(myCaughtUpThread)).toBe(
      "/threads/pgsql%2Ffoo%20bar?page=6"
    );
    expect(getTrackedThreadLatestUrl(followedUnreadThread)).toBe("/threads/pgsql%2Ffoo%20bar");
    expect(getTrackedThreadLatestUrl(myUnreadThread)).toBe("/threads/pgsql%2Ffoo%20bar");
  });

  it("fetches counts first, loads the default followed tab, and starts prefetching the inactive tab", async () => {
    const calls: string[] = [];
    const myPage = deferred<Paginated<TrackedThread>>();

    const controller = createTrackedThreadTabsController({
      counts: async () => {
        calls.push("counts");
        return { followedThreads: 3, myThreads: 7 };
      },
      tabs: {
        followed: async () => {
          calls.push("followed");
          return page([trackedThread("followed-1")], "followed-next");
        },
        my: async () => {
          calls.push("my");
          return myPage.promise;
        },
      },
    });

    await controller.initialize();

    let state = readState(controller.state);

    expect(calls).toEqual(["counts", "followed", "my"]);
    expect(state.activeTab).toBe("followed");
    expect(state.tabs.followed.count).toBe(3);
    expect(state.tabs.my.count).toBe(7);
    expect(state.tabs.followed.items.map((item) => item.thread_id)).toEqual(["followed-1"]);
    expect(state.tabs.followed.nextCursor).toBe("followed-next");
    expect(state.tabs.my.hasLoaded).toBe(true);
    expect(state.tabs.my.loading).toBe(true);
    expect(state.tabs.my.items).toEqual([]);

    myPage.resolve(page([trackedThread("my-1")], null));
    await flushPromises();

    state = readState(controller.state);
    expect(state.tabs.my.loading).toBe(false);
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);
  });

  it("surfaces count fetch failures before any tab rows load", async () => {
    const calls: string[] = [];

    const controller = createTrackedThreadTabsController({
      counts: async () => {
        calls.push("counts");
        throw apiError("Tracked-thread counts failed", 503);
      },
      tabs: {
        followed: async () => {
          calls.push("followed");
          return page([trackedThread("followed-1")], null);
        },
        my: async () => {
          calls.push("my");
          return page([trackedThread("my-1")], null);
        },
      },
    });

    await controller.initialize();

    const state = readState(controller.state);

    expect(calls).toEqual(["counts"]);
    expect(state.countsLoaded).toBe(false);
    expect(state.countsLoading).toBe(false);
    expect(state.countsError?.message).toBe("Tracked-thread counts failed");
    expect(state.tabs.followed.hasLoaded).toBe(false);
    expect(state.tabs.my.hasLoaded).toBe(false);
    expect(state.tabs.followed.items).toEqual([]);
    expect(state.tabs.my.items).toEqual([]);
  });

  it("opens My Threads first when followed count is zero and lazy-loads it", async () => {
    const calls: string[] = [];

    const controller = createTrackedThreadTabsController({
      counts: async () => {
        calls.push("counts");
        return { followedThreads: 0, myThreads: 2 };
      },
      tabs: {
        followed: async () => {
          calls.push("followed");
          return page([trackedThread("followed-1")], null);
        },
        my: async () => {
          calls.push("my");
          return page([trackedThread("my-1")], null);
        },
      },
    });

    await controller.initialize();

    const state = readState(controller.state);

    expect(calls).toEqual(["counts", "my"]);
    expect(state.activeTab).toBe("my");
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);
    expect(state.tabs.followed.hasLoaded).toBe(false);
  });

  it("prefetches the inactive tab after initialize and does not refetch it on revisits", async () => {
    let followedCalls = 0;
    let myCalls = 0;

    const controller = createTrackedThreadTabsController({
      counts: async () => ({ followedThreads: 4, myThreads: 2 }),
      tabs: {
        followed: async () => {
          followedCalls += 1;
          return page([trackedThread(`followed-${followedCalls}`)], null);
        },
        my: async () => {
          myCalls += 1;
          return page([trackedThread(`my-${myCalls}`)], null);
        },
      },
    });

    await controller.initialize();
    await controller.activateTab("my");
    await controller.activateTab("followed");
    await controller.activateTab("my");

    const state = readState(controller.state);

    expect(followedCalls).toBe(1);
    expect(myCalls).toBe(1);
    expect(state.activeTab).toBe("my");
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);
  });

  it("keeps followed-thread loading and pagination state independent from My Threads", async () => {
    const initialFollowed = deferred<Paginated<TrackedThread>>();
    const moreFollowed = deferred<Paginated<TrackedThread>>();
    const followedCursors: Array<string | undefined> = [];
    let followedCallCount = 0;

    const controller = createTrackedThreadTabsController({
      counts: async () => ({ followedThreads: 2, myThreads: 1 }),
      tabs: {
        followed: async (params) => {
          followedCallCount += 1;
          followedCursors.push(params?.cursor);

          if (followedCallCount === 1) {
            return initialFollowed.promise;
          }

          return moreFollowed.promise;
        },
        my: async () => page([trackedThread("my-1")], null),
      },
    });

    const initializePromise = controller.initialize();
    await flushPromises();

    let state = readState(controller.state);
    expect(state.activeTab).toBe("followed");
    expect(state.tabs.followed.loading).toBe(true);
    expect(state.tabs.my.loading).toBe(false);
    expect(state.tabs.my.hasLoaded).toBe(false);

    initialFollowed.resolve(page([trackedThread("followed-1")], "followed-next"));
    await initializePromise;

    state = readState(controller.state);
    expect(state.tabs.followed.loading).toBe(false);
    expect(state.tabs.followed.items.map((item) => item.thread_id)).toEqual(["followed-1"]);
    expect(state.tabs.followed.nextCursor).toBe("followed-next");

    const loadMorePromise = controller.loadMore("followed");
    await flushPromises();

    state = readState(controller.state);
    expect(state.tabs.followed.loadingMore).toBe(true);
    expect(state.tabs.my.loadingMore).toBe(false);

    moreFollowed.resolve(page([trackedThread("followed-2")], null));
    await loadMorePromise;

    state = readState(controller.state);
    expect(followedCursors).toEqual([undefined, "followed-next"]);
    expect(state.tabs.followed.loadingMore).toBe(false);
    expect(state.tabs.followed.items.map((item) => item.thread_id)).toEqual([
      "followed-1",
      "followed-2",
    ]);
    expect(state.tabs.followed.nextCursor).toBeNull();
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);
  });

  it("preserves a followed-thread error while My Threads can still load empty independently", async () => {
    const controller = createTrackedThreadTabsController({
      counts: async () => ({ followedThreads: 1, myThreads: 0 }),
      tabs: {
        followed: async () => {
          throw apiError("Followed threads exploded", 503);
        },
        my: async () => page([], null),
      },
    });

    await controller.initialize();

    let state = readState(controller.state);
    expect(state.activeTab).toBe("followed");
    expect(state.tabs.followed.error?.message).toBe("Followed threads exploded");
    expect(state.tabs.followed.items).toEqual([]);
    expect(state.tabs.my.hasLoaded).toBe(false);
    expect(state.tabs.my.error).toBeNull();

    await controller.activateTab("my");

    state = readState(controller.state);
    expect(state.tabs.my.hasLoaded).toBe(true);
    expect(state.tabs.my.items).toEqual([]);
    expect(state.tabs.my.error).toBeNull();
    expect(state.tabs.followed.error?.message).toBe("Followed threads exploded");
  });

  it("preserves a followed empty state while My Threads can fail independently", async () => {
    const controller = createTrackedThreadTabsController({
      counts: async () => ({ followedThreads: 0, myThreads: 0 }),
      tabs: {
        followed: async () => page([], null),
        my: async () => {
          throw apiError("My Threads failed", 502);
        },
      },
    });

    await controller.initialize();

    let state = readState(controller.state);
    expect(state.activeTab).toBe("followed");
    expect(state.tabs.followed.hasLoaded).toBe(true);
    expect(state.tabs.followed.items).toEqual([]);
    expect(state.tabs.followed.error).toBeNull();
    expect(state.tabs.my.hasLoaded).toBe(false);

    await controller.activateTab("my");
    state = readState(controller.state);
    expect(state.tabs.my.error?.message).toBe("My Threads failed");
    expect(state.tabs.followed.items).toEqual([]);
    expect(state.tabs.followed.error).toBeNull();
  });

  it("keeps My Threads pagination and load-more errors independent from followed threads", async () => {
    let myCallCount = 0;
    const myMore = deferred<Paginated<TrackedThread>>();

    const controller = createTrackedThreadTabsController({
      counts: async () => ({ followedThreads: 3, myThreads: 2 }),
      tabs: {
        followed: async () => page([trackedThread("followed-1")], null),
        my: async (params) => {
          myCallCount += 1;

          if (params?.cursor) {
            return myMore.promise;
          }

          return page([trackedThread("my-1")], "my-next");
        },
      },
    });

    await controller.initialize();
    await controller.activateTab("my");

    let state = readState(controller.state);
    expect(state.tabs.followed.items.map((item) => item.thread_id)).toEqual(["followed-1"]);
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);

    const loadMorePromise = controller.loadMore("my");
    await flushPromises();

    state = readState(controller.state);
    expect(state.tabs.my.loadingMore).toBe(true);
    expect(state.tabs.followed.loadingMore).toBe(false);

    myMore.reject(apiError("My Threads load more failed", 504));
    await loadMorePromise;

    state = readState(controller.state);
    expect(myCallCount).toBe(2);
    expect(state.tabs.my.loadingMore).toBe(false);
    expect(state.tabs.my.error?.message).toBe("My Threads load more failed");
    expect(state.tabs.my.items.map((item) => item.thread_id)).toEqual(["my-1"]);
    expect(state.tabs.my.nextCursor).toBe("my-next");
    expect(state.tabs.followed.items.map((item) => item.thread_id)).toEqual(["followed-1"]);
    expect(state.tabs.followed.error).toBeNull();
  });
});
