import { readonly, writable, type Readable } from "svelte/store";
import type { Paginated, TrackedThread, TrackedThreadCounts } from "shared/api";
import { api, toApiErrorShape, type ApiErrorShape, type ListTrackedThreadsParams } from "./api";
import { threadDetailPath } from "../router";

export const TRACKED_THREAD_TABS = ["followed", "my"] as const;

export type TrackedThreadTab = (typeof TRACKED_THREAD_TABS)[number];

export interface TrackedThreadTabState {
  count: number;
  error: ApiErrorShape | null;
  hasLoaded: boolean;
  items: TrackedThread[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
}

export interface TrackedThreadTabsState {
  activeTab: TrackedThreadTab;
  countsError: ApiErrorShape | null;
  countsLoaded: boolean;
  countsLoading: boolean;
  tabs: Record<TrackedThreadTab, TrackedThreadTabState>;
}

interface TrackedThreadLoaders {
  counts: () => Promise<TrackedThreadCounts>;
  tabs: Record<
    TrackedThreadTab,
    (params?: ListTrackedThreadsParams) => Promise<Paginated<TrackedThread>>
  >;
}

export interface TrackedThreadTabsController {
  activateTab(tab: TrackedThreadTab): Promise<void>;
  initialize(): Promise<void>;
  loadMore(tab: TrackedThreadTab): Promise<void>;
  reset(): void;
  state: Readable<TrackedThreadTabsState>;
}

const TRACKED_THREAD_TAB_TITLES: Record<TrackedThreadTab, string> = {
  followed: "Followed Threads",
  my: "My Threads",
};

const TRACKED_THREAD_EMPTY_MESSAGES: Record<TrackedThreadTab, string> = {
  followed: "No followed threads yet.",
  my: "No threads in My Threads yet.",
};

const TRACKED_THREAD_LOADING_TITLES: Record<TrackedThreadTab, string> = {
  followed: "Loading followed threads",
  my: "Loading My Threads",
};

const TRACKED_THREAD_LOADING_MESSAGES: Record<TrackedThreadTab, string> = {
  followed: "Fetching your followed threads.",
  my: "Fetching threads you started or replied to.",
};

const TRACKED_THREAD_ERROR_TITLES: Record<TrackedThreadTab, string> = {
  followed: "Unable to load followed threads",
  my: "Unable to load My Threads",
};

const createTabState = (): TrackedThreadTabState => ({
  count: 0,
  error: null,
  hasLoaded: false,
  items: [],
  loading: false,
  loadingMore: false,
  nextCursor: null,
});

export function createInitialTrackedThreadTabsState(): TrackedThreadTabsState {
  return {
    activeTab: "followed",
    countsError: null,
    countsLoaded: false,
    countsLoading: false,
    tabs: {
      followed: createTabState(),
      my: createTabState(),
    },
  };
}

export function getDefaultTrackedThreadTab(counts: TrackedThreadCounts): TrackedThreadTab {
  if (counts.followedThreads === 0 && counts.myThreads > 0) {
    return "my";
  }

  return "followed";
}

export function getTrackedThreadTabTitle(tab: TrackedThreadTab): string {
  return TRACKED_THREAD_TAB_TITLES[tab];
}

export function getTrackedThreadTabLabel(tab: TrackedThreadTab, count: number): string {
  return `${getTrackedThreadTabTitle(tab)} (${count})`;
}

export function getTrackedThreadEmptyMessage(tab: TrackedThreadTab): string {
  return TRACKED_THREAD_EMPTY_MESSAGES[tab];
}

export function getTrackedThreadLoadingCopy(tab: TrackedThreadTab): {
  message: string;
  title: string;
} {
  return {
    message: TRACKED_THREAD_LOADING_MESSAGES[tab],
    title: TRACKED_THREAD_LOADING_TITLES[tab],
  };
}

export function getTrackedThreadErrorTitle(tab: TrackedThreadTab): string {
  return TRACKED_THREAD_ERROR_TITLES[tab];
}

export function getTrackedThreadResumeUrl(
  thread: Pick<
    TrackedThread,
    "id" | "thread_id" | "has_unread" | "resume_page" | "first_unread_message_id" | "latest_page"
  >
): string {
  const base = threadDetailPath(thread.id || thread.thread_id);

  if (thread.has_unread && thread.resume_page !== null && thread.first_unread_message_id !== null) {
    return `${base}?page=${thread.resume_page}#message-${thread.first_unread_message_id}`;
  }

  return `${base}?page=${thread.latest_page}`;
}

export function getTrackedThreadLatestUrl(
  thread: Pick<TrackedThread, "id" | "thread_id">
): string {
  return threadDetailPath(thread.id || thread.thread_id);
}

function withCounts(
  state: TrackedThreadTabsState,
  counts: TrackedThreadCounts
): TrackedThreadTabsState {
  return {
    ...state,
    tabs: {
      followed: {
        ...state.tabs.followed,
        count: counts.followedThreads,
      },
      my: {
        ...state.tabs.my,
        count: counts.myThreads,
      },
    },
  };
}

export function createTrackedThreadTabsController(
  loaders: TrackedThreadLoaders = {
    counts: () => api.me.trackedThreadCounts(),
    tabs: {
      followed: (params) => api.me.followedThreads(params),
      my: (params) => api.me.myThreads(params),
    },
  }
): TrackedThreadTabsController {
  const store = writable<TrackedThreadTabsState>(createInitialTrackedThreadTabsState());
  let state = createInitialTrackedThreadTabsState();
  let initializePromise: Promise<void> | null = null;

  const requestIds: Record<TrackedThreadTab, number> = {
    followed: 0,
    my: 0,
  };

  const setState = (
    next:
      | TrackedThreadTabsState
      | ((current: TrackedThreadTabsState) => TrackedThreadTabsState)
  ): void => {
    const resolved = typeof next === "function" ? next(state) : next;
    state = resolved;
    store.set(resolved);
  };

  const loadTab = async (tab: TrackedThreadTab): Promise<void> => {
    const tabState = state.tabs[tab];
    if (tabState.loading || tabState.hasLoaded) {
      return;
    }

    const requestId = requestIds[tab] + 1;
    requestIds[tab] = requestId;

    setState((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [tab]: {
          ...current.tabs[tab],
          error: null,
          hasLoaded: true,
          loading: true,
        },
      },
    }));

    try {
      const page = await loaders.tabs[tab]();
      if (requestIds[tab] !== requestId) return;

      setState((current) => ({
        ...current,
        tabs: {
          ...current.tabs,
          [tab]: {
            ...current.tabs[tab],
            error: null,
            items: page.items,
            loading: false,
            loadingMore: false,
            nextCursor: page.nextCursor,
          },
        },
      }));
    } catch (error) {
      if (requestIds[tab] !== requestId) return;

      setState((current) => ({
        ...current,
        tabs: {
          ...current.tabs,
          [tab]: {
            ...current.tabs[tab],
            error: toApiErrorShape(error),
            loading: false,
            loadingMore: false,
          },
        },
      }));
    }
  };

  const prefetchInactiveTabs = (): void => {
    for (const tab of TRACKED_THREAD_TABS) {
      if (tab === state.activeTab) continue;
      if (state.tabs[tab].count === 0) continue;
      void loadTab(tab);
    }
  };

  return {
    state: readonly(store),

    async activateTab(tab: TrackedThreadTab): Promise<void> {
      setState((current) => ({
        ...current,
        activeTab: tab,
      }));

      await loadTab(tab);
    },

    async initialize(): Promise<void> {
      if (initializePromise) return initializePromise;
      if (state.countsLoaded) {
        await loadTab(state.activeTab);
        prefetchInactiveTabs();
        return;
      }

      initializePromise = (async () => {
        setState((current) => ({
          ...current,
          countsError: null,
          countsLoading: true,
        }));

        try {
          const counts = await loaders.counts();
          const activeTab = getDefaultTrackedThreadTab(counts);

          setState((current) =>
            withCounts(
              {
                ...current,
                activeTab,
                countsError: null,
                countsLoaded: true,
                countsLoading: false,
              },
              counts
            )
          );

          await loadTab(activeTab);
          prefetchInactiveTabs();
        } catch (error) {
          setState((current) => ({
            ...current,
            countsError: toApiErrorShape(error),
            countsLoading: false,
          }));
        }
      })().finally(() => {
        initializePromise = null;
      });

      return initializePromise;
    },

    async loadMore(tab: TrackedThreadTab): Promise<void> {
      const tabState = state.tabs[tab];

      if (tabState.loading || tabState.loadingMore || !tabState.nextCursor) {
        return;
      }

      const requestId = requestIds[tab] + 1;
      requestIds[tab] = requestId;

      const cursor = tabState.nextCursor;

      setState((current) => ({
        ...current,
        tabs: {
          ...current.tabs,
          [tab]: {
            ...current.tabs[tab],
            error: null,
            loadingMore: true,
          },
        },
      }));

      try {
        const page = await loaders.tabs[tab]({ cursor });
        if (requestIds[tab] !== requestId) return;

        setState((current) => ({
          ...current,
          tabs: {
            ...current.tabs,
            [tab]: {
              ...current.tabs[tab],
              error: null,
              items: [...current.tabs[tab].items, ...page.items],
              loadingMore: false,
              nextCursor: page.nextCursor,
            },
          },
        }));
      } catch (error) {
        if (requestIds[tab] !== requestId) return;

        setState((current) => ({
          ...current,
          tabs: {
            ...current.tabs,
            [tab]: {
              ...current.tabs[tab],
              error: toApiErrorShape(error),
              loadingMore: false,
            },
          },
        }));
      }
    },

    reset(): void {
      initializePromise = null;
      requestIds.followed = 0;
      requestIds.my = 0;
      setState(createInitialTrackedThreadTabsState());
    },
  };
}
