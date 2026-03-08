<script lang="ts">
  import type { ThreadWithMessages } from "shared/api";
  import { onDestroy } from "svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import ThreadTimeline from "../components/thread/ThreadTimeline.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import {
    parseThreadsDetailContext,
    serializeThreadsDetailContext,
  } from "../lib/state/threadsQuery";
  import { onLinkClick, threadsPath } from "../router";

  type ThreadDetailStatus = "idle" | "loading" | "success" | "error";
  type LoadMode = "replace" | "preserve";

  export let threadId: string;

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const numberFormatter = new Intl.NumberFormat("en-US");

  let activeRequestController: AbortController | null = null;
  let error: ApiErrorShape | null = null;
  let hasThreadId = false;
  let isRefreshing = false;
  let lastLoadedThreadId: string | null = null;
  let requestSequence = 0;
  let status: ThreadDetailStatus = "idle";
  let thread: ThreadWithMessages | null = null;
  let backToThreadsPath = threadsPath;

  const threadSubject = (subject: string | null): string => {
    const normalized = subject?.trim() ?? "";
    return normalized.length > 0 ? normalized : "(No subject)";
  };

  const listLabel = (listName: string): string => {
    const normalized = listName.trim();
    return normalized.length > 0 ? normalized : "Unknown list";
  };

  const formatDateTime = (value: string | null): string => {
    if (!value) return "Unknown";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return dateFormatter.format(parsed);
  };

  const formatErrorDetail = (apiError: ApiErrorShape | null): string | null => {
    if (!apiError) return null;
    const fallbackPath = `/api/threads/${encodeURIComponent(threadId)}`;
    const path = apiError.path || fallbackPath;

    if (apiError.status > 0) {
      return `${apiError.method} ${path} -> ${apiError.status}`;
    }

    return `${apiError.method} ${path} -> ${apiError.code ?? "NETWORK_ERROR"}`;
  };

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const loadThread = async (targetThreadId: string, mode: LoadMode): Promise<void> => {
    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;

    const requestId = ++requestSequence;
    const hasThread = thread !== null;

    error = null;
    if (mode === "replace" || !hasThread) {
      thread = null;
      status = "loading";
      isRefreshing = false;
    } else {
      isRefreshing = true;
    }

    try {
      const response = await api.threads.get(targetThreadId, { signal: requestController.signal });
      if (requestId !== requestSequence) return;

      thread = response;
      status = "success";
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      error = apiError;
      if (mode === "replace" || !hasThread) {
        thread = null;
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
    if (!hasThreadId) return;
    void loadThread(threadId, "preserve");
  };

  const syncBackToThreadsPath = (): void => {
    if (typeof window === "undefined") {
      backToThreadsPath = threadsPath;
      return;
    }

    const detailContext = parseThreadsDetailContext(window.location.search);
    const detailSearch = serializeThreadsDetailContext(
      detailContext.query,
      detailContext.restoreScrollY
    );
    backToThreadsPath = `${threadsPath}${detailSearch}`;
  };

  $: hasThreadId = threadId.length > 0;

  $: if (!hasThreadId) {
    backToThreadsPath = threadsPath;
  } else {
    syncBackToThreadsPath();
  }

  $: if (!hasThreadId) {
    requestSequence += 1;
    clearActiveRequest();

    error = null;
    isRefreshing = false;
    lastLoadedThreadId = null;
    thread = null;
    status = "error";
  } else if (threadId !== lastLoadedThreadId) {
    lastLoadedThreadId = threadId;
    void loadThread(threadId, "replace");
  }

  $: isBusy = status === "loading" || isRefreshing;
  $: isInitialLoad = status === "idle" || (status === "loading" && thread === null);
  $: isNotFound = hasThreadId && status === "error" && error?.status === 404;
  $: isInvalidThreadResponse =
    hasThreadId &&
    status === "error" &&
    (error?.status === 400 || error?.status === 422 || error?.code === "BAD_REQUEST");

  onDestroy(() => {
    requestSequence += 1;
    clearActiveRequest();
  });
</script>

<section class="page">
  <header class="page-header">
    <div class="header-copy">
      <h1 class="page-title" data-route-heading tabindex="-1">Thread Detail</h1>
      {#if thread}
        <p>Thread ID <code>{thread.thread_id}</code></p>
      {:else}
        <p>Thread ID <code>{threadId}</code></p>
      {/if}
    </div>

    <button class="refresh-button" type="button" disabled={!hasThreadId || isBusy} on:click={retry}
      >{isBusy ? "Refreshing..." : "Refresh"}</button
    >
  </header>

  {#if !hasThreadId}
    <ErrorState
      title="Missing thread ID"
      message="This route does not include a thread identifier."
      detail="Expected /threads/:threadId"
    />
  {:else if isInitialLoad}
    <LoadingState
      title="Loading thread metadata"
      message="Subject, list, activity, and message totals are loading."
    />
  {:else if isNotFound}
    <ErrorState
      title="Thread not found"
      message="No thread exists for this identifier."
      detail={formatErrorDetail(error)}
    />
  {:else if isInvalidThreadResponse}
    <ErrorState
      title="Invalid thread identifier"
      message={error?.message ?? "The thread request is not valid."}
      detail={formatErrorDetail(error)}
    />
  {:else if status === "error" && thread === null}
    <div class="status-block">
      <ErrorState
        title="Unable to load thread"
        message={error?.message ?? "Thread request failed."}
        detail={formatErrorDetail(error)}
      />
      <button class="retry-button" type="button" on:click={retry}>Retry thread fetch</button>
    </div>
  {:else if thread}
    {#if isRefreshing}
      <p class="inline-status" role="status">Refreshing thread metadata...</p>
    {/if}

    {#if error}
      <ErrorState
        title="Unable to refresh thread data"
        message={error.message}
        detail={formatErrorDetail(error)}
      />
    {/if}

    <article class="summary-card" aria-label="Thread metadata">
      <h3>{threadSubject(thread.subject)}</h3>
      <dl>
        <div>
          <dt>List</dt>
          <dd>{listLabel(thread.list_name)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(thread.started_at)}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatDateTime(thread.last_activity_at)}</dd>
        </div>
        <div>
          <dt>Message count</dt>
          <dd>{numberFormatter.format(thread.message_count)}</dd>
        </div>
        <div>
          <dt>Loaded messages</dt>
          <dd>{numberFormatter.format(thread.messages.length)}</dd>
        </div>
      </dl>
    </article>

    <ThreadTimeline messages={thread.messages} />
  {/if}

  <p class="route-link">
    <a href={backToThreadsPath} on:click={(event) => onLinkClick(event, backToThreadsPath)}
      >Back to threads</a
    >
  </p>
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

  code {
    overflow-wrap: anywhere;
  }

  .refresh-button,
  .retry-button {
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
    font-size: 0.84rem;
    color: #486581;
  }

  .summary-card {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .summary-card h3 {
    margin: 0;
    font-size: 0.97rem;
    color: #102a43;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .summary-card dl {
    margin: 0;
    display: grid;
    gap: 0.45rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    min-width: 0;
  }

  .summary-card div {
    border: 1px solid #d9e2ec;
    border-radius: 0.55rem;
    background: #f8fbff;
    padding: 0.45rem 0.55rem;
    min-width: 0;
  }

  .summary-card dt {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #486581;
  }

  .summary-card dd {
    margin: 0.15rem 0 0;
    color: #102a43;
    font-size: 0.86rem;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .route-link a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
  }
</style>
