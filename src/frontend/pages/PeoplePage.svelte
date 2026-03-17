<script lang="ts">
  import type { PersonListItem } from "shared/api";
  import EmptyState from "../components/EmptyState.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import PeopleList from "../components/people/PeopleList.svelte";
  import PeoplePaginationControls from "../components/people/PeoplePaginationControls.svelte";
  import { api, clampPeopleLimit, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { onDestroy, onMount } from "svelte";

  type PeoplePageStatus = "idle" | "loading" | "success" | "empty" | "error";
  type LoadMode = "replace" | "preserve";

  const LIMIT_OPTIONS = [10, 25, 50, 100];
  const DEFAULT_LIMIT = 25;

  let activeRequestController: AbortController | null = null;
  let error: ApiErrorShape | null = null;
  let hasNextPage = false;
  let hasPreviousPage = false;
  let isBusy = false;
  let isInitialLoad = true;
  let isRefreshing = false;
  let limit = DEFAULT_LIMIT;
  let listItems: PersonListItem[] = [];
  let nextCursor: string | null = null;
  let pageCursors: Array<string | undefined> = [undefined];
  let pageIndex = 0;
  let pageNumber = 1;
  let rankOffset = 0;
  let requestSequence = 0;
  let status: PeoplePageStatus = "idle";

  $: hasPreviousPage = pageIndex > 0;
  $: hasNextPage = nextCursor !== null;
  $: pageNumber = pageIndex + 1;
  $: rankOffset = pageIndex * limit;
  $: isInitialLoad = status === "idle" || (status === "loading" && listItems.length === 0);
  $: isBusy = status === "loading" || isRefreshing;

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const cursorForPage = (index: number): string | undefined => pageCursors[index];

  const formatErrorDetail = (apiError: ApiErrorShape | null): string | null => {
    if (!apiError) return null;
    const path = apiError.path || "/api/people";

    if (apiError.status > 0) {
      return `${apiError.method} ${path} -> ${apiError.status}`;
    }

    return `${apiError.method} ${path} -> ${apiError.code ?? "NETWORK_ERROR"}`;
  };

  const loadPage = async (
    targetPageIndex: number,
    cursor: string | undefined,
    mode: LoadMode
  ): Promise<void> => {
    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;

    const requestId = ++requestSequence;
    const hasItems = listItems.length > 0;

    error = null;
    if (mode === "replace" || !hasItems) {
      status = "loading";
      if (mode === "replace") {
        listItems = [];
        nextCursor = null;
      }
    } else {
      isRefreshing = true;
    }

    try {
      const response = await api.people.list(
        { cursor, limit: clampPeopleLimit(limit) },
        { signal: requestController.signal }
      );
      if (requestId !== requestSequence) return;

      listItems = response.items;
      nextCursor = response.nextCursor;
      status = response.items.length === 0 ? "empty" : "success";

      const nextTrail = [...pageCursors.slice(0, targetPageIndex), cursor];
      if (response.nextCursor !== null) {
        nextTrail.push(response.nextCursor);
      }
      pageCursors = nextTrail;
      pageIndex = targetPageIndex;
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      error = apiError;
      if (mode === "replace" || !hasItems) {
        status = "error";
      }
    } finally {
      if (requestId !== requestSequence) return;
      isRefreshing = false;
      if (activeRequestController === requestController) {
        activeRequestController = null;
      }
    }
  };

  const retry = (): void => {
    const mode: LoadMode = listItems.length > 0 ? "preserve" : "replace";
    void loadPage(pageIndex, cursorForPage(pageIndex), mode);
  };

  const loadPreviousPage = (): void => {
    if (!hasPreviousPage || isBusy) return;
    const targetPageIndex = pageIndex - 1;
    void loadPage(targetPageIndex, cursorForPage(targetPageIndex), "preserve");
  };

  const loadNextPage = (): void => {
    if (!hasNextPage || isBusy || nextCursor === null) return;
    void loadPage(pageIndex + 1, nextCursor, "preserve");
  };

  const handleLimitChange = (event: CustomEvent<number>): void => {
    const nextLimit = clampPeopleLimit(event.detail);
    if (nextLimit === limit) return;

    limit = nextLimit;
    pageIndex = 0;
    pageCursors = [undefined];
    nextCursor = null;

    void loadPage(0, undefined, "replace");
  };

  onMount(() => {
    void loadPage(0, undefined, "replace");
  });

  onDestroy(() => {
    clearActiveRequest();
  });
</script>

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">People</h1>

  {#if isInitialLoad}
    <LoadingState
      title="Loading contributor leaderboard"
      message="Contributor rankings and message totals are loading."
    />
  {:else if status === "error"}
    <div class="status-block">
      <ErrorState
        title="Unable to load contributors"
        message={error?.message ?? "Contributor requests failed."}
        detail={formatErrorDetail(error)}
      />
      <button class="retry-button" type="button" on:click={retry}>Retry contributor fetch</button>
    </div>
  {:else}
    <PeoplePaginationControls
      limit={limit}
      limitOptions={LIMIT_OPTIONS}
      hasPreviousPage={hasPreviousPage}
      hasNextPage={hasNextPage}
      isBusy={isBusy}
      pageNumber={pageNumber}
      on:previous={loadPreviousPage}
      on:next={loadNextPage}
      on:limitchange={handleLimitChange}
    />

    {#if error}
      <ErrorState
        title="Unable to load requested page"
        message={error.message}
        detail={formatErrorDetail(error)}
      />
    {/if}

    {#if isRefreshing}
      <p class="inline-status" role="status">Refreshing contributor page...</p>
    {/if}

    {#if status === "empty"}
      <EmptyState
        title="No contributors found"
        message="Contributor rankings will appear once message data is available."
      />
    {:else}
      <PeopleList items={listItems} rankOffset={rankOffset} />
    {/if}
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .retry-button {
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

  .retry-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .status-block {
    display: grid;
    gap: 0.65rem;
    justify-items: start;
    min-width: 0;
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
