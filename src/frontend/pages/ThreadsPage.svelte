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
    applyThreadsFilterPatch,
    THREADS_QUERY_DEFAULT_LIMIT,
    clampThreadsQueryLimit,
    createDefaultThreadsQueryState,
    parseThreadsDetailContext,
    serializeThreadsDetailContext,
    serializeThreadsQuery,
    updateThreadsQueryState,
    type ThreadsQueryPatch,
    type ThreadsQueryState,
  } from "../lib/state/threadsQuery";
  import { navigate, threadsPath } from "../router";

  type ListsStatus = "idle" | "loading" | "success" | "error";
  type LoadMode = "replace" | "preserve";
  type ThreadsStatus = "idle" | "loading" | "success" | "empty" | "error";

  const LIMIT_OPTIONS = [10, 25, 50, 100];

  let activeListsRequestController: AbortController | null = null;
  let activeThreadsRequestController: AbortController | null = null;
  let isRefreshing = false;
  let lists: List[] = [];
  let listsError: ApiErrorShape | null = null;
  let listsStatus: ListsStatus = "idle";
  let nextCursor: string | null = null;
  let pendingRestoreScrollY: number | null = null;
  let queryState: ThreadsQueryState = createDefaultThreadsQueryState();
  let requestSequence = 0;
  let status: ThreadsStatus = "idle";
  let threads: Thread[] = [];
  let threadsError: ApiErrorShape | null = null;

  $: detailContextSearch = serializeThreadsDetailContext(queryState);
  $: fromDate = toDateInputValue(queryState.from);
  $: hasActiveCursor = typeof queryState.cursor === "string";
  $: isBusy = status === "loading" || isRefreshing;
  $: isInitialLoad = status === "idle" || (status === "loading" && threads.length === 0);
  $: listsErrorMessage = listsError?.message ?? null;
  $: toDate = toDateInputValue(queryState.to);
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

  const clearActiveThreadsRequest = (): void => {
    if (!activeThreadsRequestController) return;

    activeThreadsRequestController.abort();
    activeThreadsRequestController = null;
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

    const detailContext = parseThreadsDetailContext(window.location.search);
    const parsed = detailContext.query;
    const canonicalSearch = serializeThreadsQuery(parsed);

    queryState = parsed;
    pendingRestoreScrollY = detailContext.restoreScrollY ?? null;

    if (canonicalSearch !== window.location.search) {
      navigate(withSearch(threadsPath, canonicalSearch), { replace: true });
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

  const loadThreads = async (state: ThreadsQueryState, mode: LoadMode): Promise<void> => {
    clearActiveThreadsRequest();
    const requestController = new AbortController();
    activeThreadsRequestController = requestController;

    const requestId = ++requestSequence;
    const hasThreads = threads.length > 0;

    threadsError = null;
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
          to: state.to,
        },
        { signal: requestController.signal }
      );
      if (requestId !== requestSequence) return;

      threads = response.items;
      nextCursor = response.nextCursor;
      status = response.items.length === 0 ? "empty" : "success";
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

  const commitQueryState = (nextState: ThreadsQueryState, mode: LoadMode = "replace"): void => {
    const currentSearch = serializeThreadsQuery(queryState);
    const nextSearch = serializeThreadsQuery(nextState);

    if (nextSearch === currentSearch) return;

    queryState = nextState;

    if (typeof window !== "undefined" && nextSearch !== window.location.search) {
      navigate(withSearch(threadsPath, nextSearch));
    }

    void loadThreads(nextState, mode);
  };

  const applyFilterPatch = (patch: ThreadsQueryPatch): void => {
    const nextState = applyThreadsFilterPatch(queryState, patch);
    commitQueryState(nextState, "replace");
  };

  const loadNextPage = (): void => {
    if (!nextCursor || isBusy) return;

    const nextState = updateThreadsQueryState(queryState, { cursor: nextCursor });
    commitQueryState(nextState, "replace");
  };

  const resetCursor = (): void => {
    if (!hasActiveCursor) return;

    const nextState = updateThreadsQueryState(queryState, { cursor: null });
    commitQueryState(nextState, "replace");
  };

  const clearFilters = (): void => {
    const nextState = updateThreadsQueryState(queryState, {
      cursor: null,
      from: null,
      limit: THREADS_QUERY_DEFAULT_LIMIT,
      list: null,
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

  const handleListChange = (event: CustomEvent<string | null>): void => {
    applyFilterPatch({ list: event.detail });
  };

  const handleFromDateChange = (event: CustomEvent<string | null>): void => {
    applyFilterPatch({ from: event.detail });
  };

  const handleToDateChange = (event: CustomEvent<string | null>): void => {
    applyFilterPatch({ to: event.detail });
  };

  const handleLimitChange = (event: CustomEvent<number>): void => {
    applyFilterPatch({ limit: clampThreadsQueryLimit(event.detail) });
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
    clearActiveThreadsRequest();
    clearActiveListsRequest();
  });
</script>

<section class="page">
  <header class="page-header">
    <div class="header-copy">
      <h1 class="page-title" data-route-heading tabindex="-1">Threads</h1>
      <p>Filter list activity, scan conversation subjects, and open thread timelines.</p>
    </div>

    <button class="refresh-button" type="button" disabled={isBusy} on:click={retryThreads}
      >{isBusy ? "Refreshing..." : "Refresh"}</button
    >
  </header>

  <ThreadsFilters
    selectedList={queryState.list}
    fromDate={fromDate}
    toDate={toDate}
    limit={queryState.limit}
    limitOptions={LIMIT_OPTIONS}
    listOptions={lists}
    isBusy={isBusy}
    isListsLoading={listsStatus === "loading"}
    listsErrorMessage={listsStatus === "error" ? listsErrorMessage : null}
    on:listchange={handleListChange}
    on:fromchange={handleFromDateChange}
    on:tochange={handleToDateChange}
    on:limitchange={handleLimitChange}
    on:clear={clearFilters}
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
      hasNextPage={nextCursor !== null}
      isBusy={isBusy}
      on:next={loadNextPage}
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

    {#if status === "empty"}
      <div class="status-block">
        <EmptyState
          title="No threads matched this filter set"
          message="Try widening the date range, clearing filters, or choosing a different list."
        />
        <button class="reset-button" type="button" on:click={clearFilters}>Clear filters</button>
      </div>
    {:else}
      <ThreadsResultsTable items={threads} contextSearch={detailContextSearch} />
    {/if}
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.8rem;
    flex-wrap: wrap;
  }

  .header-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .page-title {
    margin: 0;
    font-size: 1.2rem;
    color: #102a43;
  }

  p {
    margin: 0;
    color: #486581;
    line-height: 1.4;
    min-width: 0;
  }

  .refresh-button,
  .retry-button,
  .reset-button {
    border: 1px solid #6f9fdd;
    border-radius: 0.55rem;
    background: #e8f2ff;
    color: #0b4ea2;
    font-weight: 650;
    font-size: 0.86rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .refresh-button:disabled,
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
    border-color: #c5d0da;
    background: #f2f5f8;
    color: #334e68;
  }

  .inline-status {
    font-size: 0.84rem;
    color: #486581;
  }

  @media (max-width: 480px) {
    .refresh-button {
      width: 100%;
    }
  }
</style>
