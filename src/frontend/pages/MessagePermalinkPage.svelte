<script lang="ts">
  import { onDestroy } from "svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { navigate, onLinkClick, threadDetailPath, threadsPath } from "../router";

  export let messageId: string;

  type MessagePermalinkStatus = "idle" | "loading" | "error";

  let activeRequestController: AbortController | null = null;
  let error: ApiErrorShape | null = null;
  let lastRequestedMessageId: string | null = null;
  let requestSequence = 0;
  let status: MessagePermalinkStatus = "idle";

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const formatErrorDetail = (apiError: ApiErrorShape | null): string | null => {
    if (!apiError) return null;
    const fallbackPath = `/api/messages/${encodeURIComponent(messageId)}/permalink`;
    const path = apiError.path || fallbackPath;

    if (apiError.status > 0) {
      return `${apiError.method} ${path} -> ${apiError.status}`;
    }

    return `${apiError.method} ${path} -> ${apiError.code ?? "NETWORK_ERROR"}`;
  };

  const buildTargetUrl = (targetThreadId: string, targetMessageId: string, targetPage: number): string =>
    `${threadDetailPath(targetThreadId)}?page=${targetPage}#message-${targetMessageId}`;

  const loadMessagePermalink = async (targetMessageId: string): Promise<void> => {
    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;

    const requestId = ++requestSequence;
    error = null;
    status = "loading";

    try {
      const permalink = await api.messages.getPermalink(targetMessageId, {
        signal: requestController.signal,
      });
      if (requestId !== requestSequence) return;

      navigate(buildTargetUrl(permalink.threadId, permalink.messageId, permalink.page), {
        replace: true,
      });
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      error = apiError;
      status = "error";
    } finally {
      if (requestId !== requestSequence) return;
      if (activeRequestController === requestController) {
        activeRequestController = null;
      }
    }
  };

  $: normalizedMessageId = messageId.trim();
  $: if (normalizedMessageId && normalizedMessageId !== lastRequestedMessageId) {
    lastRequestedMessageId = normalizedMessageId;
    void loadMessagePermalink(normalizedMessageId);
  }

  onDestroy(() => {
    requestSequence += 1;
    clearActiveRequest();
  });
</script>

<section class="page">
  <header>
    <h1 class="page-title" data-route-heading tabindex="-1">Opening message</h1>
    <p>Resolving this message link inside its thread.</p>
  </header>

  {#if status === "error"}
    <ErrorState
      title="Unable to open message link"
      message={error?.message ?? "Please retry in a moment."}
      detail={formatErrorDetail(error)}
    />

    <p class="route-link">
      <a href={threadsPath} on:click={(event) => onLinkClick(event, threadsPath)}>Go to threads</a>
    </p>
  {:else}
    <LoadingState title="Opening message" message="Finding the right thread page for this message." />
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  header {
    display: grid;
    gap: 0.2rem;
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
  }

  .route-link a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
  }
</style>
