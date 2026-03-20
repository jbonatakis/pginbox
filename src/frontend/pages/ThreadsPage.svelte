<script lang="ts">
  import type { List, Thread } from "shared/api";
  import { onDestroy, onMount } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import ThreadsCursorControls from "../components/threads/ThreadsCursorControls.svelte";
  import ThreadsFilters from "../components/threads/ThreadsFilters.svelte";
  import ThreadsResultsTable from "../components/threads/ThreadsResultsTable.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import {
    getThreadsDetailHistoryContext,
    withoutThreadsDetailHistoryContext,
  } from "../lib/threadDetailNavigation";
  import { authStore } from "../lib/state/auth";
  import {
    applyThreadsFilterPatch,
    THREADS_QUERY_DEFAULT_LIMIT,
    clampThreadsQueryLimit,
    createDefaultThreadsQueryState,
    parseThreadsQuery,
    serializeThreadsQuery,
    updateThreadsQueryState,
    type ThreadsQueryPatch,
    type ThreadsQueryState,
  } from "../lib/state/threadsQuery";
  import { navigate, threadsPath } from "../router";

  type ListsStatus = "idle" | "loading" | "success" | "error";
  type LoadMode = "replace" | "preserve";
  type ThreadsStatus = "idle" | "loading" | "success" | "empty" | "error";
  type SubmittedFilters = {
    from: string | null;
    limit: number;
    list: string | null;
    q: string | null;
    to: string | null;
  };

  const LIMIT_OPTIONS = [10, 25, 50, 100];

  let activeListsRequestController: AbortController | null = null;
  let activeFollowStatesRequestController: AbortController | null = null;
  let activeThreadsRequestController: AbortController | null = null;
  let followStateLoadError: ApiErrorShape | null = null;
  let followStateRequestSequence = 0;
  let followStatesLoadedKey: string | null = null;
  let followStatesRequestedKey: string | null = null;
  let isRefreshing = false;
  let lists: List[] = [];
  let listsError: ApiErrorShape | null = null;
  let listsStatus: ListsStatus = "idle";
  let nextCursor: string | null = null;
  let pageCursors: Array<string | undefined> = [undefined];
  let pageIndex = 0;
  let pendingRestoreScrollY: number | null = null;
  let followError: ApiErrorShape | null = null;
  let pendingFollowThreadIds: string[] = [];
  let queryState: ThreadsQueryState = createDefaultThreadsQueryState();
  let requestSequence = 0;
  let status: ThreadsStatus = "idle";
  let threads: Thread[] = [];
  let threadsError: ApiErrorShape | null = null;

  $: detailContextSearch = serializeThreadsQuery(queryState);
  $: fromDate = toDateInputValue(queryState.from);
  $: hasActiveCursor = typeof queryState.cursor === "string";
  $: hasPreviousPage = pageIndex > 0;
  $: isBusy = status === "loading" || isRefreshing;
  $: isInitialLoad = status === "idle" || (status === "loading" && threads.length === 0);
  $: listsErrorMessage = listsError?.message ?? null;
  $: searchQuery = queryState.q ?? "";
  $: threadIdsKey = threads.map((thread) => thread.thread_id).join(",");
  $: toDate = toDateInputValue(queryState.to);
  $: if ($authStore.isBootstrapped && !$authStore.isAuthenticated) {
    clearActiveFollowStatesRequest();
    followStateLoadError = null;
    followStatesLoadedKey = null;
    followStatesRequestedKey = null;
  }
  $: if (
    $authStore.isBootstrapped &&
    $authStore.isAuthenticated &&
    status === "success" &&
    threads.length > 0 &&
    threadIdsKey.length > 0 &&
    followStatesLoadedKey !== threadIdsKey &&
    followStatesRequestedKey !== threadIdsKey
  ) {
    void loadFollowStates(threads);
  }
  $: if (
    typeof window !== "undefined" &&
    pendingRestoreScrollY !== null &&
    status !== "idle" &&
    status !== "loading"
  ) {
    const targetScrollY = pendingRestoreScrollY;
    pendingRestoreScrollY = null;

    window.requestAnimationFrame(() => {
      window.scrollTo({ left: 0, top: targetScrollY });
    });
  }

  const withSearch = (pathname: string, search: string): string => `${pathname}${search}`;

  const toDateInputValue = (value: string | undefined): string => {
    if (!value) return "";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  };

  const clearActiveListsRequest = (): void => {
    if (!activeListsRequestController) return;

    activeListsRequestController.abort();
    activeListsRequestController = null;
  };

  const clearActiveFollowStatesRequest = (): void => {
    if (!activeFollowStatesRequestController) return;

    activeFollowStatesRequestController.abort();
    activeFollowStatesRequestController = null;
  };

  const clearActiveThreadsRequest = (): void => {
    if (!activeThreadsRequestController) return;

    activeThreadsRequestController.abort();
    activeThreadsRequestController = null;
  };

  const cursorForPage = (index: number): string | undefined => pageCursors[index];

  const normalizeCursor = (value: string | null | undefined): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const syncCursorTrail = (
    currentCursor: string | undefined,
    responseNextCursor: string | null,
    targetPageIndex?: number
  ): void => {
    const nextKnownCursor = normalizeCursor(responseNextCursor);

    if (targetPageIndex !== undefined) {
      const nextTrail = [...pageCursors.slice(0, targetPageIndex), currentCursor];
      if (nextKnownCursor !== undefined) {
        nextTrail.push(nextKnownCursor);
      }
      pageCursors = nextTrail;
      pageIndex = targetPageIndex;
      return;
    }

    const knownIndex = pageCursors.findIndex((cursor) => cursor === currentCursor);
    if (knownIndex !== -1) {
      const nextTrail = [...pageCursors.slice(0, knownIndex), currentCursor];
      if (nextKnownCursor !== undefined) {
        nextTrail.push(nextKnownCursor);
      }
      pageCursors = nextTrail;
      pageIndex = knownIndex;
      return;
    }

    const nextTrail = [currentCursor];
    if (nextKnownCursor !== undefined) {
      nextTrail.push(nextKnownCursor);
    }
    pageCursors = nextTrail;
    pageIndex = 0;
  };

  const formatErrorDetail = (apiError: ApiErrorShape | null, fallbackPath: string): string | null => {
    if (!apiError) return null;

    const path = apiError.path || fallbackPath;
    if (apiError.status > 0) {
      return `${apiError.method} ${path} -> ${apiError.status}`;
    }

    return `${apiError.method} ${path} -> ${apiError.code ?? "NETWORK_ERROR"}`;
  };

  const syncStateFromLocation = (): ThreadsQueryState => {
    if (typeof window === "undefined") return queryState;

    const parsed = parseThreadsQuery(window.location.search);
    const canonicalSearch = serializeThreadsQuery(parsed);
    const historyContext = getThreadsDetailHistoryContext(window.history.state);
    const matchesHistoryContext = historyContext?.search === canonicalSearch;

    queryState = parsed;
    pendingRestoreScrollY = matchesHistoryContext ? historyContext?.restoreScrollY ?? null : null;

    if (canonicalSearch !== window.location.search) {
      const nextUrl = withSearch(threadsPath, canonicalSearch);
      const nextState = matchesHistoryContext
        ? withoutThreadsDetailHistoryContext(window.history.state)
        : window.history.state;
      window.history.replaceState(nextState, "", nextUrl);
    } else if (matchesHistoryContext) {
      const nextState = withoutThreadsDetailHistoryContext(window.history.state);
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState(nextState, "", currentUrl);
    }

    return parsed;
  };

  const loadLists = async (): Promise<void> => {
    clearActiveListsRequest();
    const requestController = new AbortController();
    activeListsRequestController = requestController;

    listsError = null;
    listsStatus = "loading";

    try {
      const response = await api.lists.list({ signal: requestController.signal });
      lists = [...response].sort((left, right) => left.name.localeCompare(right.name));
      listsStatus = "success";
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED") return;

      lists = [];
      listsError = apiError;
      listsStatus = "error";
    } finally {
      if (activeListsRequestController === requestController) {
        activeListsRequestController = null;
      }
    }
  };

  const loadThreads = async (
    state: ThreadsQueryState,
    mode: LoadMode,
    targetPageIndex?: number
  ): Promise<void> => {
    clearActiveThreadsRequest();
    followStateRequestSequence += 1;
    clearActiveFollowStatesRequest();
    followStatesLoadedKey = null;
    followStatesRequestedKey = null;
    const requestController = new AbortController();
    activeThreadsRequestController = requestController;

    const requestId = ++requestSequence;
    const hasThreads = threads.length > 0;

    threadsError = null;
    followError = null;
    followStateLoadError = null;
    if (mode === "replace" || !hasThreads) {
      status = "loading";
      isRefreshing = false;

      if (mode === "replace") {
        threads = [];
        nextCursor = null;
      }
    } else {
      isRefreshing = true;
    }

    try {
      const response = await api.threads.list(
        {
          cursor: state.cursor,
          from: state.from,
          limit: clampThreadsQueryLimit(state.limit),
          list: state.list,
          q: state.q,
          to: state.to,
        },
        { signal: requestController.signal }
      );
      if (requestId !== requestSequence) return;

      threads = response.items;
      nextCursor = response.nextCursor;
      syncCursorTrail(normalizeCursor(state.cursor), response.nextCursor, targetPageIndex);
      status = response.items.length === 0 ? "empty" : "success";

      if ($authStore.isBootstrapped && $authStore.isAuthenticated && response.items.length > 0) {
        void loadFollowStates(response.items);
      }
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      threadsError = apiError;

      if (mode === "replace" || !hasThreads) {
        status = "error";
        threads = [];
        nextCursor = null;
      }
    } finally {
      if (requestId !== requestSequence) return;

      isRefreshing = false;
      if (activeThreadsRequestController === requestController) {
        activeThreadsRequestController = null;
      }
    }
  };

  const loadFollowStates = async (items: Thread[]): Promise<void> => {
    const threadIds = items.map((thread) => thread.thread_id);
    const threadIdSet = new Set(threadIds);
    const nextKey = threadIds.join(",");

    if (
      threadIds.length === 0 ||
      !$authStore.isBootstrapped ||
      !$authStore.isAuthenticated ||
      followStatesLoadedKey === nextKey ||
      followStatesRequestedKey === nextKey
    ) {
      return;
    }

    clearActiveFollowStatesRequest();
    const requestController = new AbortController();
    activeFollowStatesRequestController = requestController;

    const requestId = ++followStateRequestSequence;
    followStateLoadError = null;
    followStatesRequestedKey = nextKey;

    try {
      const response = await api.me.threadFollowStates(
        { threadIds },
        { signal: requestController.signal }
      );
      if (requestId !== followStateRequestSequence) return;

      threads = threads.map((thread) => {
        if (!threadIdSet.has(thread.thread_id)) return thread;

        return {
          ...thread,
          is_followed: response.states[thread.thread_id]?.isFollowed ?? false,
        };
      });
      followStatesLoadedKey = nextKey;
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== followStateRequestSequence) return;

      followStateLoadError = apiError;
    } finally {
      if (activeFollowStatesRequestController === requestController) {
        activeFollowStatesRequestController = null;
      }
    }
  };

  const commitQueryState = (
    nextState: ThreadsQueryState,
    mode: LoadMode = "replace",
    targetPageIndex?: number
  ): void => {
    const currentSearch = serializeThreadsQuery(queryState);
    const nextSearch = serializeThreadsQuery(nextState);

    if (nextSearch === currentSearch) return;

    queryState = nextState;

    if (typeof window !== "undefined" && nextSearch !== window.location.search) {
      navigate(withSearch(threadsPath, nextSearch));
    }

    void loadThreads(nextState, mode, targetPageIndex);
  };

  const applyFilterPatch = (patch: ThreadsQueryPatch): void => {
    const nextState = applyThreadsFilterPatch(queryState, patch);
    commitQueryState(nextState, "replace");
  };

  const loadNextPage = (): void => {
    if (!nextCursor || isBusy) return;

    const nextState = updateThreadsQueryState(queryState, { cursor: nextCursor });
    commitQueryState(nextState, "replace", pageIndex + 1);
  };

  const loadPreviousPage = (): void => {
    if (!hasPreviousPage || isBusy) return;

    const targetPageIndex = pageIndex - 1;
    const previousCursor = cursorForPage(targetPageIndex);
    const nextState = updateThreadsQueryState(queryState, { cursor: previousCursor ?? null });
    commitQueryState(nextState, "replace", targetPageIndex);
  };

  const resetCursor = (): void => {
    if (!hasActiveCursor) return;

    const nextState = updateThreadsQueryState(queryState, { cursor: null });
    commitQueryState(nextState, "replace", 0);
  };

  const clearFilters = (): void => {
    const nextState = updateThreadsQueryState(queryState, {
      cursor: null,
      from: null,
      limit: THREADS_QUERY_DEFAULT_LIMIT,
      list: null,
      q: null,
      to: null,
    });
    commitQueryState(nextState, "replace");
  };

  const retryLists = (): void => {
    void loadLists();
  };

  const retryThreads = (): void => {
    const mode: LoadMode = threads.length > 0 ? "preserve" : "replace";
    void loadThreads(queryState, mode);
  };

  const retryFollowStates = (): void => {
    followStateLoadError = null;
    followStatesRequestedKey = null;
    void loadFollowStates(threads);
  };

  const handleSearchSubmit = (event: CustomEvent<SubmittedFilters>): void => {
    applyFilterPatch({
      from: event.detail.from,
      limit: clampThreadsQueryLimit(event.detail.limit),
      list: event.detail.list,
      q: event.detail.q,
      to: event.detail.to,
    });
  };

  const updateThreadFollowState = (
    requestedThreadId: string,
    nextThreadId: string,
    isFollowed: boolean
  ): void => {
    threads = threads.map((thread) => {
      if (thread.thread_id !== requestedThreadId && thread.thread_id !== nextThreadId) {
        return thread;
      }

      return {
        ...thread,
        thread_id: thread.thread_id === requestedThreadId ? nextThreadId : thread.thread_id,
        is_followed: isFollowed,
      };
    });
  };

  const handleToggleFollow = async (
    event: CustomEvent<{ isFollowed: boolean; threadId: string }>
  ): Promise<void> => {
    if (!$authStore.isAuthenticated) return;

    const { isFollowed, threadId } = event.detail;
    if (pendingFollowThreadIds.includes(threadId)) return;

    followError = null;
    pendingFollowThreadIds = [...pendingFollowThreadIds, threadId];

    try {
      const result = isFollowed
        ? await api.threads.unfollow(threadId)
        : await api.threads.follow(threadId);
      updateThreadFollowState(threadId, result.threadId, result.isFollowed);
    } catch (error) {
      followError = toApiErrorShape(error);
    } finally {
      pendingFollowThreadIds = pendingFollowThreadIds.filter((id) => id !== threadId);
    }
  };

  onMount(() => {
    const initialState = syncStateFromLocation();

    void loadLists();
    void loadThreads(initialState, "replace");

    const handlePopState = (): void => {
      const poppedState = syncStateFromLocation();
      void loadThreads(poppedState, "replace");
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  });

  onDestroy(() => {
    requestSequence += 1;
    followStateRequestSequence += 1;
    clearActiveFollowStatesRequest();
    clearActiveThreadsRequest();
    clearActiveListsRequest();
  });
</script>

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">Threads</h1>

  <ThreadsFilters
    defaultLimit={THREADS_QUERY_DEFAULT_LIMIT}
    searchQuery={searchQuery}
    selectedList={queryState.list}
    fromDate={fromDate}
    toDate={toDate}
    limit={queryState.limit}
    limitOptions={LIMIT_OPTIONS}
    listOptions={lists}
    isBusy={isBusy}
    isListsLoading={listsStatus === "loading"}
    listsErrorMessage={listsStatus === "error" ? listsErrorMessage : null}
    on:searchsubmit={handleSearchSubmit}
    on:retrylists={retryLists}
  />

  {#if isInitialLoad}
    <LoadingState
      title="Loading thread explorer"
      message="Thread filters and results are loading from the archive API."
    />
  {:else if status === "error"}
    <div class="status-block">
      <ErrorState
        title="Unable to load threads"
        message={threadsError?.message ?? "Thread requests failed."}
        detail={formatErrorDetail(threadsError, "/api/threads")}
      />
      <div class="status-actions">
        <button class="retry-button" type="button" on:click={retryThreads}>Retry thread fetch</button>
        <button class="reset-button" type="button" on:click={clearFilters}>Reset filters</button>
      </div>
    </div>
  {:else}
    <ThreadsCursorControls
      hasActiveCursor={hasActiveCursor}
      {hasPreviousPage}
      hasNextPage={nextCursor !== null}
      isBusy={isBusy}
      on:next={loadNextPage}
      on:previous={loadPreviousPage}
      on:reset={resetCursor}
    />

    {#if isRefreshing}
      <p class="inline-status" role="status">Refreshing thread results...</p>
    {/if}

    {#if threadsError}
      <ErrorState
        title="Unable to refresh thread results"
        message={threadsError.message}
        detail={formatErrorDetail(threadsError, "/api/threads")}
      />
    {/if}

    {#if $authStore.isAuthenticated && followError}
      <ErrorState
        title="Unable to update follow state"
        message={followError.message}
        detail={formatErrorDetail(followError, "/api/threads/:threadId/follow")}
      />
    {/if}

    {#if $authStore.isAuthenticated && followStateLoadError}
      <div class="status-block">
        <ErrorState
          title="Unable to load follow state"
          message={followStateLoadError.message}
          detail={formatErrorDetail(followStateLoadError, "/api/me/thread-follow-states")}
        />
        <button class="retry-button" type="button" on:click={retryFollowStates}>
          Retry follow state
        </button>
      </div>
    {/if}

    {#if status === "empty"}
      <div class="status-block">
        <EmptyState
          title="No threads matched this filter set"
          message="Try widening the date range, clearing filters, or choosing a different list."
        />
        <button class="reset-button" type="button" on:click={clearFilters}>Clear filters</button>
      </div>
    {:else}
      <ThreadsResultsTable
        items={threads}
        contextSearch={detailContextSearch}
        canManageFollows={$authStore.isAuthenticated}
        pendingThreadIds={pendingFollowThreadIds}
        on:togglefollow={handleToggleFollow}
      />
    {/if}
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .retry-button,
  .reset-button {
    border: 1px solid rgba(111, 159, 221, 0.76);
    border-radius: 0.55rem;
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 650;
    font-size: 0.86rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .retry-button:disabled,
  .reset-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .status-block {
    display: grid;
    gap: 0.65rem;
    justify-items: start;
    min-width: 0;
  }

  .status-actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .reset-button {
    border-color: var(--border);
    background: #f2f5f8;
    color: var(--text-subtle);
  }

  .inline-status {
    margin: 0;
    font-size: 0.84rem;
    color: var(--text-muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
