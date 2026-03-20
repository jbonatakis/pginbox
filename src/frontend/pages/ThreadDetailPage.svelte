<script lang="ts">
  import type { ThreadDetail, ThreadFollowState, ThreadProgress } from "shared/api";
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import ThreadPageControls from "../components/thread/ThreadPageControls.svelte";
  import ThreadTimeline from "../components/thread/ThreadTimeline.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { threadDetailDocumentTitle } from "../lib/documentTitle";
  import { buildHashAnchorApplicationKey, parseHashAnchorId } from "../lib/hashAnchor";
  import {
    buildThreadCanonicalSharePath,
    getThreadsDetailHistoryContext,
    withThreadsDetailHistoryContext,
    withoutThreadsDetailHistoryContext,
  } from "../lib/threadDetailNavigation";
  import {
    getThreadDetailTrackingView,
    mergeThreadProgressTrackingState,
    type ThreadDetailTrackingView,
  } from "../lib/threadDetailTracking";
  import { authStore } from "../lib/state/auth";
  import {
    parseThreadDetailPage,
    parseThreadsQuery,
    serializeThreadsQuery,
    withThreadDetailPage,
  } from "../lib/state/threadsQuery";
  import { isClientNavigationEvent, navigate, onLinkClick, threadsPath } from "../router";

  type ThreadDetailStatus = "idle" | "loading" | "success" | "error";
  type LoadMode = "navigate" | "refresh" | "replace";
  type LoadThreadOptions = {
    preserveHashAnchor?: boolean;
    scrollToTop?: boolean;
  };

  export let threadId: string;

  const THREAD_MESSAGES_PAGE_LIMIT = 50;
  const JUMP_TO_TOP_VISIBILITY_OFFSET = 280;
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const numberFormatter = new Intl.NumberFormat("en-US");

  let activeRequestController: AbortController | null = null;
  let activeProgressRequestController: AbortController | null = null;
  let error: ApiErrorShape | null = null;
  let errorMode: LoadMode | null = null;
  let errorPage: number | null = null;
  let hasThreadId = false;
  let isBannerBusy = false;
  let isNavigatingPage = false;
  let isRefreshing = false;
  let lastLoadedThreadId: string | null = null;
  let requestedPage: number | null = null;
  let requestSequence = 0;
  let shareLinkStatus: "idle" | "success" | "error" = "idle";
  let shareLinkStatusTimeoutId: number | null = null;
  let showJumpToTop = false;
  let status: ThreadDetailStatus = "idle";
  let thread: ThreadDetail | null = null;
  let progress: ThreadProgress | null = null;
  let progressRequestedThreadId: string | null = null;
  let backToThreadsPath = threadsPath;
  let backToThreadsRestoreScrollY: number | null = null;
  let pendingCanonicalThreadId: string | null = null;
  let lastAppliedHashAnchorKey: string | null = null;
  let retryNavigateOptions: LoadThreadOptions = {};
  let trackingView: ThreadDetailTrackingView | null = null;

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

  const pageSummaryLabel = (page: number, totalPages: number): string => {
    if (totalPages <= 1) return "Single-page thread.";
    if (page === 1) return `Page 1 of ${numberFormatter.format(totalPages)} (oldest).`;
    if (page === totalPages) {
      return `Page ${numberFormatter.format(page)} of ${numberFormatter.format(totalPages)} (latest).`;
    }
    return `Page ${numberFormatter.format(page)} of ${numberFormatter.format(totalPages)}.`;
  };

  const messageRangeLabel = (startIndex: number, count: number, totalCount: number): string => {
    if (count === 0) return "No messages are available for this page.";
    const start = startIndex + 1;
    const end = startIndex + count;
    if (start === end) {
      return `Showing message ${numberFormatter.format(start)} of ${numberFormatter.format(totalCount)}.`;
    }
    return `Showing messages ${numberFormatter.format(start)}-${numberFormatter.format(end)} of ${numberFormatter.format(totalCount)}.`;
  };

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const clearProgressRequest = (): void => {
    if (!activeProgressRequestController) return;
    activeProgressRequestController.abort();
    activeProgressRequestController = null;
  };

  const fetchProgress = async (
    targetThreadId: string,
    signal?: AbortSignal
  ): Promise<ThreadProgress | null> => {
    clearProgressRequest();
    const requestController = new AbortController();
    activeProgressRequestController = requestController;
    progressRequestedThreadId = targetThreadId;

    const abortProgressRequest = (): void => {
      requestController.abort();
    };

    signal?.addEventListener("abort", abortProgressRequest, { once: true });

    try {
      return await api.threads.getProgress(targetThreadId, {}, { signal: requestController.signal });
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED") return null;
      return null;
    } finally {
      signal?.removeEventListener("abort", abortProgressRequest);
      if (activeProgressRequestController === requestController) {
        activeProgressRequestController = null;
      }
    }
  };

  const locationPage = (): number | undefined => {
    if (typeof window === "undefined") return undefined;
    return parseThreadDetailPage(window.location.search);
  };

  const syncLocationPage = (
    page: number,
    totalPages: number,
    { preserveHashAnchor = true }: LoadThreadOptions = {}
  ): void => {
    if (typeof window === "undefined") return;

    const nextSearch = withThreadDetailPage(
      window.location.search,
      page < totalPages ? page : null
    );
    const nextHash = preserveHashAnchor ? window.location.hash : "";

    if (nextSearch === window.location.search && nextHash === window.location.hash) return;

    const nextUrl = `${window.location.pathname}${nextSearch}${nextHash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  };

  const currentHashAnchorId = (): string | null => {
    if (typeof window === "undefined") return null;
    return parseHashAnchorId(window.location.hash);
  };

  const currentHashAnchorKey = (page: number): string | null => {
    if (typeof window === "undefined") return null;
    return buildHashAnchorApplicationKey(`${threadId}:${page}`, window.location.hash);
  };

  const scrollToCurrentHashAnchor = async (anchorKey: string): Promise<void> => {
    await tick();

    const anchorId = currentHashAnchorId();
    if (!anchorId) {
      lastAppliedHashAnchorKey = null;
      return;
    }

    const anchorElement = document.getElementById(anchorId);
    if (anchorElement) {
      anchorElement.scrollIntoView({ block: "start" });
    }

    syncJumpToTopVisibility();
    lastAppliedHashAnchorKey = anchorKey;
  };

  const syncJumpToTopVisibility = (): void => {
    if (typeof window === "undefined") {
      showJumpToTop = false;
      return;
    }

    showJumpToTop = window.scrollY > JUMP_TO_TOP_VISIBILITY_OFFSET;
  };

  const scrollToTop = (): void => {
    if (typeof window === "undefined") return;
    showJumpToTop = false;
    window.requestAnimationFrame(() => {
      window.scrollTo({ left: 0, top: 0 });
    });
  };

  const jumpToTop = (): void => {
    if (typeof window === "undefined") return;
    showJumpToTop = false;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({
      left: 0,
      top: 0,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  };

  const clearShareLinkStatusTimeout = (): void => {
    if (shareLinkStatusTimeoutId === null || typeof window === "undefined") return;
    window.clearTimeout(shareLinkStatusTimeoutId);
    shareLinkStatusTimeoutId = null;
  };

  const setShareLinkStatus = (nextStatus: "success" | "error"): void => {
    shareLinkStatus = nextStatus;
    clearShareLinkStatusTimeout();

    if (typeof window === "undefined") return;
    shareLinkStatusTimeoutId = window.setTimeout(() => {
      shareLinkStatus = "idle";
      shareLinkStatusTimeoutId = null;
    }, 2500);
  };

  const copyTextToClipboard = async (value: string): Promise<boolean> => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // fall through to the document-based fallback
      }
    }

    if (typeof document === "undefined") return false;

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();

    const didCopy = document.execCommand("copy");
    textarea.remove();
    return didCopy;
  };

  const copyShareLink = async (): Promise<void> => {
    if (!thread || typeof window === "undefined") return;

    const sharePath = buildThreadCanonicalSharePath(
      thread.id,
      thread.messagePagination.page,
      thread.messagePagination.totalPages,
      window.location.hash
    );
    const didCopy = await copyTextToClipboard(`${window.location.origin}${sharePath}`);
    setShareLinkStatus(didCopy ? "success" : "error");
  };

  const loadThread = async (
    targetThreadId: string,
    mode: LoadMode,
    targetPage?: number,
    options: LoadThreadOptions = {}
  ): Promise<void> => {
    const { preserveHashAnchor = true, scrollToTop: shouldScrollToTop = false } = options;

    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;

    const requestId = ++requestSequence;
    const hasThread = thread !== null;

    error = null;
    errorMode = null;
    errorPage = null;
    requestedPage = targetPage ?? null;

    if (mode === "replace" || !hasThread) {
      clearProgressRequest();
      thread = null;
      progress = null;
      progressRequestedThreadId = null;
      status = "loading";
      isNavigatingPage = false;
      isRefreshing = false;
    } else if (mode === "navigate") {
      retryNavigateOptions = options;
      isNavigatingPage = true;
      isRefreshing = false;
    } else {
      isNavigatingPage = false;
      isRefreshing = true;
    }

    try {
      const authState = get(authStore);
      const shouldLoadProgress = authState.isBootstrapped && authState.isAuthenticated;

      const [response, progressResponse] = await Promise.all([
        api.threads.get(
          targetThreadId,
          { limit: THREAD_MESSAGES_PAGE_LIMIT, page: targetPage },
          { signal: requestController.signal }
        ),
        shouldLoadProgress
          ? fetchProgress(targetThreadId, requestController.signal)
          : Promise.resolve(null),
      ]);
      if (requestId !== requestSequence) return;

      thread = response;
      progress = progressResponse;
      if (progressResponse !== null) {
        progressRequestedThreadId = response.id;
      }
      status = "success";
      syncLocationPage(response.messagePagination.page, response.messagePagination.totalPages, {
        preserveHashAnchor,
      });
      if (typeof window !== "undefined") {
        const canonicalPath = buildThreadCanonicalSharePath(
          response.id,
          response.messagePagination.page,
          response.messagePagination.totalPages,
          window.location.hash
        );
        const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (canonicalPath !== currentPath) {
          pendingCanonicalThreadId = response.id;
          navigate(canonicalPath, { replace: true });
        }
      }
      if (mode === "navigate" && shouldScrollToTop) {
        scrollToTop();
      }
      syncJumpToTopVisibility();
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      error = apiError;
      errorMode = mode;
      errorPage = targetPage ?? null;
      if (mode === "replace" || !hasThread) {
        thread = null;
        status = "error";
      }
    } finally {
      if (requestId !== requestSequence) return;

      isNavigatingPage = false;
      isRefreshing = false;
      requestedPage = null;
      if (activeRequestController === requestController) {
        activeRequestController = null;
      }
    }
  };

  const retry = (): void => {
    if (!hasThreadId) return;
    if (thread === null) {
      void loadThread(threadId, "replace", locationPage());
      return;
    }
    if (errorMode === "navigate" && errorPage !== null) {
      void loadThread(threadId, "navigate", errorPage, retryNavigateOptions);
      return;
    }
    void loadThread(threadId, "refresh", thread.messagePagination.page);
  };

  const goToPage = (page: number): void => {
    if (!thread || isBusy) return;
    const totalPages = thread.messagePagination.totalPages;
    const nextPage = Math.max(1, Math.min(page, totalPages));
    if (nextPage === thread.messagePagination.page) return;
    void loadThread(threadId, "navigate", nextPage, {
      preserveHashAnchor: false,
      scrollToTop: true,
    });
  };

  const resumeReading = (event: MouseEvent): void => {
    event.preventDefault();
    if (trackingView === null || trackingView.resumeTarget === null) return;

    const { anchorId, targetPage, targetThreadId, targetUrl } = trackingView.resumeTarget;

    if (targetThreadId !== threadId) {
      navigate(targetUrl);
      return;
    }

    if (typeof window !== "undefined") {
      const urlWithHash = `${window.location.pathname}${window.location.search}#${anchorId}`;
      window.history.replaceState(window.history.state, "", urlWithHash);
    }

    if (!thread || targetPage !== thread.messagePagination.page) {
      void loadThread(threadId, "navigate", targetPage, {
        preserveHashAnchor: true,
        scrollToTop: false,
      });
    } else {
      lastAppliedHashAnchorKey = null;
      const anchorKey = currentHashAnchorKey(thread.messagePagination.page);
      if (anchorKey) {
        void scrollToCurrentHashAnchor(anchorKey);
      }
    }
  };

  const markRead = async (): Promise<void> => {
    if (isBannerBusy || trackingView === null || !trackingView.showMarkRead) return;
    isBannerBusy = true;
    try {
      progress = await api.threads.markRead(thread?.id ?? threadId);
      progressRequestedThreadId = thread?.id ?? threadId;
    } catch {
      // silently ignore
    } finally {
      isBannerBusy = false;
    }
  };

  const toggleFollow = async (): Promise<void> => {
    if (isBannerBusy || !progress || trackingView === null) return;
    isBannerBusy = true;
    try {
      const result = progress.isFollowed
        ? await api.threads.unfollow(thread?.id ?? threadId)
        : await api.threads.follow(thread?.id ?? threadId);
      await refreshProgressFromTrackingState(result);
    } catch {
      // silently ignore
    } finally {
      isBannerBusy = false;
    }
  };

  const refreshProgressFromTrackingState = async (nextState: ThreadFollowState): Promise<void> => {
    if (!progress) return;
    const refreshedProgress = await fetchProgress(threadId);
    progress = refreshedProgress ?? mergeThreadProgressTrackingState(progress, nextState);
    progressRequestedThreadId = threadId;
  };

  const removeFromMyThreads = async (): Promise<void> => {
    if (isBannerBusy || !progress || trackingView === null || !trackingView.showRemoveFromMyThreads) return;
    isBannerBusy = true;
    try {
      const result = await api.threads.removeFromMyThreads(thread?.id ?? threadId);
      await refreshProgressFromTrackingState(result);
    } catch {
      // silently ignore
    } finally {
      isBannerBusy = false;
    }
  };

  const addBackToMyThreads = async (): Promise<void> => {
    if (isBannerBusy || !progress || trackingView === null || !trackingView.showAddBackToMyThreads) return;
    isBannerBusy = true;
    try {
      const result = await api.threads.addBackToMyThreads(thread?.id ?? threadId);
      await refreshProgressFromTrackingState(result);
    } catch {
      // silently ignore
    } finally {
      isBannerBusy = false;
    }
  };

  const goToFirstPage = (): void => {
    if (!thread) return;
    goToPage(1);
  };

  const goToPreviousPage = (): void => {
    if (!thread) return;
    goToPage(thread.messagePagination.page - 1);
  };

  const goToNextPage = (): void => {
    if (!thread) return;
    goToPage(thread.messagePagination.page + 1);
  };

  const goToLastPage = (): void => {
    if (!thread) return;
    goToPage(thread.messagePagination.totalPages);
  };

  const handlePageChange = (event: CustomEvent<number>): void => {
    goToPage(event.detail);
  };

  const syncBackToThreadsPath = (): void => {
    if (typeof window === "undefined") {
      backToThreadsPath = threadsPath;
      backToThreadsRestoreScrollY = null;
      return;
    }

    const locationSearch = serializeThreadsQuery(parseThreadsQuery(window.location.search));
    const historyContext = getThreadsDetailHistoryContext(window.history.state);
    const contextSearch = historyContext?.search ?? locationSearch;
    backToThreadsPath = `${threadsPath}${contextSearch}`;
    backToThreadsRestoreScrollY = historyContext?.restoreScrollY ?? null;

    if (historyContext !== null) {
      const nextUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState(withoutThreadsDetailHistoryContext(window.history.state), "", nextUrl);
    }
  };

  const handleBackToThreadsClick = (event: MouseEvent): void => {
    if (!isClientNavigationEvent(event)) return;

    if (typeof window !== "undefined" && backToThreadsRestoreScrollY !== null) {
      const contextSearch = backToThreadsPath.startsWith(threadsPath)
        ? backToThreadsPath.slice(threadsPath.length)
        : "";
      const nextState = withThreadsDetailHistoryContext(
        window.history.state,
        contextSearch,
        backToThreadsRestoreScrollY
      );
      const nextUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState(nextState, "", nextUrl);
    }

    onLinkClick(event, backToThreadsPath);
  };

  $: hasThreadId = threadId.length > 0;
  $: currentPage = thread?.messagePagination.page ?? 1;
  $: totalPages = thread?.messagePagination.totalPages ?? 1;
  $: pageSize = thread?.messagePagination.pageSize ?? THREAD_MESSAGES_PAGE_LIMIT;
  $: startIndex = (currentPage - 1) * pageSize;
  $: pageSummary = pageSummaryLabel(currentPage, totalPages);
  $: rangeSummary = thread ? messageRangeLabel(startIndex, thread.messages.length, thread.message_count) : null;
  $: pendingPageLabel =
    requestedPage === null || requestedPage === currentPage
      ? pageSummary
      : pageSummaryLabel(requestedPage, totalPages);

  $: if (!hasThreadId) {
    backToThreadsPath = threadsPath;
  } else {
    syncBackToThreadsPath();
  }

  $: if (!hasThreadId) {
    requestSequence += 1;
    clearActiveRequest();
    clearProgressRequest();
    clearShareLinkStatusTimeout();

    error = null;
    errorMode = null;
    errorPage = null;
    isNavigatingPage = false;
    isRefreshing = false;
    lastLoadedThreadId = null;
    pendingCanonicalThreadId = null;
    progress = null;
    progressRequestedThreadId = null;
    requestedPage = null;
    backToThreadsRestoreScrollY = null;
    shareLinkStatus = "idle";
    showJumpToTop = false;
    thread = null;
    status = "error";
  } else if (pendingCanonicalThreadId !== null && threadId === pendingCanonicalThreadId) {
    pendingCanonicalThreadId = null;
    lastLoadedThreadId = threadId;
  } else if (threadId !== lastLoadedThreadId && threadId !== pendingCanonicalThreadId) {
    clearShareLinkStatusTimeout();
    shareLinkStatus = "idle";
    lastLoadedThreadId = threadId;
    void loadThread(threadId, "replace", locationPage());
  }

  $: if (thread && $authStore.isBootstrapped) {
    if ($authStore.isAuthenticated) {
      const progressThreadId = pendingCanonicalThreadId ?? threadId;
      if (progressRequestedThreadId !== progressThreadId) {
        void fetchProgress(progressThreadId).then((response) => {
          if (threadId !== lastLoadedThreadId) return;
          progress = response;
        });
      }
    } else {
      clearProgressRequest();
      progress = null;
      progressRequestedThreadId = null;
    }
  }

  $: isBusy = status === "loading" || isNavigatingPage || isRefreshing;
  $: isInitialLoad = status === "idle" || (status === "loading" && thread === null);
  $: isNotFound = hasThreadId && status === "error" && error?.status === 404;
  $: isInvalidThreadResponse =
    hasThreadId &&
    status === "error" &&
    (error?.status === 400 || error?.status === 422 || error?.code === "BAD_REQUEST");
  $: hashAnchorKey = thread ? currentHashAnchorKey(thread.messagePagination.page) : null;
  $: trackingView = getThreadDetailTrackingView(
    $authStore.isAuthenticated,
    progress,
    thread?.id ?? threadId,
    (count) => numberFormatter.format(count)
  );
  $: documentTitle = threadDetailDocumentTitle(
    thread?.id === threadId || thread?.thread_id === threadId ? thread.subject : null,
    threadId
  );

  $: if (hashAnchorKey === null) {
    lastAppliedHashAnchorKey = null;
  } else if (hashAnchorKey !== lastAppliedHashAnchorKey) {
    void scrollToCurrentHashAnchor(hashAnchorKey);
  }

  onDestroy(() => {
    requestSequence += 1;
    clearActiveRequest();
    clearProgressRequest();
    clearShareLinkStatusTimeout();
  });
</script>

<svelte:head>
  <title>{documentTitle}</title>
</svelte:head>

<svelte:window on:scroll={syncJumpToTopVisibility} />

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">Thread Detail</h1>

  {#if !hasThreadId}
    <ErrorState
      title="Missing thread ID"
      message="This route does not include a thread identifier."
      detail="Expected /t/:threadId"
    />
  {:else if isInitialLoad}
    <LoadingState
      title="Loading latest thread activity"
      message="Subject, list, activity, and the newest page of messages are loading."
    />
  {:else if isNotFound}
    <ErrorState
      title="Thread not found"
      message="No thread exists for this identifier."
      detail={formatErrorDetail(error)}
    />
  {:else if isInvalidThreadResponse}
    <ErrorState
      title="Invalid thread request"
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
      <p class="inline-status" role="status">Refreshing {pageSummary.toLowerCase()}</p>
    {:else if isNavigatingPage}
      <p class="inline-status" role="status">Loading {pendingPageLabel.toLowerCase()}</p>
    {/if}

    {#if error}
      <div class="status-block">
        <ErrorState
          title={errorMode === "navigate" ? "Unable to change message page" : "Unable to refresh thread data"}
          message={error.message}
          detail={formatErrorDetail(error)}
        />
        <button class="retry-button" type="button" disabled={isBusy} on:click={retry}
          >{errorMode === "navigate" ? "Retry page change" : "Retry refresh"}</button
        >
      </div>
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
          <dt>Viewing</dt>
          <dd>{pageSummary}</dd>
        </div>
      </dl>
      <div class="summary-card-actions">
        <button class="summary-action-button" type="button" on:click={copyShareLink}>Copy share link</button>
        {#if shareLinkStatus === "success"}
          <p class="summary-action-status" role="status">Share link copied.</p>
        {:else if shareLinkStatus === "error"}
          <p class="summary-action-status summary-action-status--error" role="status">
            Unable to copy the share link.
          </p>
        {/if}
      </div>
    </article>

    {#if trackingView !== null}
      <div class="progress-banner">
        <div class="progress-banner-copy">
          <span class="progress-banner-status">{trackingView.statusText}</span>
          {#if trackingView.participationText}
            <p class="progress-banner-note">{trackingView.participationText}</p>
          {/if}
        </div>
        <div class="progress-banner-actions">
          {#if trackingView.showResumeReading}
            <button
              class="banner-button banner-button--primary"
              type="button"
              disabled={isBusy || isBannerBusy}
              on:click={resumeReading}
            >Resume reading</button>
          {/if}
          {#if trackingView.showMarkRead}
            <button
              class="banner-button"
              type="button"
              disabled={isBusy || isBannerBusy}
              on:click={markRead}
            >Mark as read</button>
          {/if}
          {#if trackingView.showRemoveFromMyThreads}
            <button
              class="banner-button"
              type="button"
              disabled={isBusy || isBannerBusy}
              on:click={removeFromMyThreads}
            >Remove from My Threads</button>
          {/if}
          {#if trackingView.showAddBackToMyThreads}
            <button
              class="banner-button"
              type="button"
              disabled={isBusy || isBannerBusy}
              on:click={addBackToMyThreads}
            >Add back to My Threads</button>
          {/if}
          <button
            class="banner-button banner-button--follow"
            type="button"
            disabled={isBusy || isBannerBusy}
            on:click={toggleFollow}
          >{trackingView.followButtonLabel}</button>
        </div>
      </div>
    {/if}

    <ThreadPageControls
      {currentPage}
      {isBusy}
      {pageSummary}
      {rangeSummary}
      {totalPages}
      selectId="thread-page-select-top"
      on:first={goToFirstPage}
      on:previous={goToPreviousPage}
      on:pagechange={handlePageChange}
      on:next={goToNextPage}
      on:last={goToLastPage}
    />

    <ThreadTimeline
      messages={thread.messages}
      startIndex={startIndex}
      totalCount={thread.message_count}
      firstUnreadMessageId={trackingView?.timelineFirstUnreadMessageId ?? null}
      threadId={trackingView?.timelineThreadId ?? threadId}
      isAuthenticated={$authStore.isAuthenticated}
      trackReadProgress={trackingView?.trackReadProgress ?? false}
    />

    <ThreadPageControls
      {currentPage}
      {isBusy}
      {pageSummary}
      {rangeSummary}
      {totalPages}
      selectId="thread-page-select-bottom"
      on:first={goToFirstPage}
      on:previous={goToPreviousPage}
      on:pagechange={handlePageChange}
      on:next={goToNextPage}
      on:last={goToLastPage}
    />

    {#if showJumpToTop}
      <button class="jump-to-top-button" type="button" on:click={jumpToTop} aria-label="Jump to top">
        <span class="jump-to-top-icon" aria-hidden="true">↑</span>
        <span>Top</span>
      </button>
    {/if}
  {/if}

  <p class="route-link">
    <a href={backToThreadsPath} class="route-link-anchor" on:click={handleBackToThreadsClick}>
      <span class="route-link-icon" aria-hidden="true">←</span>
      <span>Back to threads</span>
    </a>
  </p>
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

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
    color: #486581;
  }

  .summary-card {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    min-width: 0;
  }

  .summary-card {
    display: grid;
    gap: 0.55rem;
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

  .summary-card-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.55rem;
  }

  .summary-action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.4rem;
    padding: 0.52rem 0.88rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    color: #334e68;
    font-size: 0.88rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .summary-action-button:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .summary-action-status {
    margin: 0;
    color: #486581;
    font-size: 0.82rem;
    font-weight: 600;
  }

  .summary-action-status--error {
    color: #8a1c1c;
  }

  .progress-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    border: 1px solid #b3cde8;
    border-radius: 0.75rem;
    background: #e8f2ff;
    padding: 0.65rem 0.85rem;
    min-width: 0;
  }

  .progress-banner-copy {
    flex: 1 1 auto;
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .progress-banner-status {
    font-size: 0.88rem;
    font-weight: 600;
    color: #102a43;
  }

  .progress-banner-note {
    margin: 0;
    color: #486581;
    font-size: 0.82rem;
    line-height: 1.35;
  }

  .progress-banner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .banner-button {
    border: 1px solid #6f9fdd;
    border-radius: 0.55rem;
    background: #ffffff;
    color: #0b4ea2;
    font-weight: 650;
    font-size: 0.83rem;
    line-height: 1;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .banner-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .banner-button--primary {
    background: #0b4ea2;
    color: #ffffff;
    border-color: #0b4ea2;
  }

  .banner-button--primary:not(:disabled):hover {
    background: #0d5bc0;
  }

  .banner-button:not(.banner-button--primary):not(:disabled):hover {
    background: #d0e4f7;
  }

  .route-link {
    margin: 0;
    display: flex;
    justify-content: flex-start;
  }

  .route-link-anchor {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 2.5rem;
    padding: 0.52rem 0.88rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.88);
    color: #334e68;
    font-size: 0.9rem;
    font-weight: 700;
    line-height: 1;
    text-decoration: none;
    box-shadow: 0 10px 24px rgba(16, 42, 67, 0.06);
  }

  .route-link-anchor:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .route-link-icon {
    font-size: 1rem;
    line-height: 1;
  }

  .jump-to-top-button {
    position: fixed;
    right: max(1rem, calc(0.75rem + env(safe-area-inset-right)));
    bottom: max(1rem, calc(0.75rem + env(safe-area-inset-bottom)));
    z-index: 40;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid rgba(11, 78, 162, 0.25);
    border-radius: 999px;
    background: rgba(11, 78, 162, 0.94);
    color: #ffffff;
    font-weight: 700;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.72rem 0.9rem;
    box-shadow: 0 14px 32px rgba(16, 42, 67, 0.18);
    cursor: pointer;
    backdrop-filter: blur(8px);
  }

  .jump-to-top-button:hover {
    background: rgba(12, 90, 191, 0.96);
  }

  .jump-to-top-icon {
    font-size: 0.95rem;
    line-height: 1;
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

  @media (max-width: 640px) {
    .jump-to-top-button {
      right: max(0.85rem, calc(0.65rem + env(safe-area-inset-right)));
      bottom: max(0.85rem, calc(0.65rem + env(safe-area-inset-bottom)));
      padding: 0.68rem 0.82rem;
    }
  }
</style>
