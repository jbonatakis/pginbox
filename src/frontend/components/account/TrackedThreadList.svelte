<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { TrackedThread } from "shared/api";
  import type { ApiErrorShape } from "../../lib/api";
  import {
    getTrackedThreadErrorTitle,
    getTrackedThreadLoadingCopy,
    getTrackedThreadResumeUrl,
    type TrackedThreadTab,
  } from "../../lib/trackedThreads";
  import { onLinkClick } from "../../router";
  import ErrorState from "../ErrorState.svelte";
  import LoadingState from "../LoadingState.svelte";

  export let emptyMessage: string;
  export let error: ApiErrorShape | null = null;
  export let formatDateTime: (value: string | null | undefined) => string;
  export let items: TrackedThread[] = [];
  export let loading = false;
  export let loadingMore = false;
  export let nextCursor: string | null = null;
  export let tab: TrackedThreadTab;

  const dispatch = createEventDispatcher<{
    loadmore: { tab: TrackedThreadTab };
  }>();

  const handleLoadMore = (): void => {
    dispatch("loadmore", { tab });
  };
</script>

{#if loading}
  {@const loadingCopy = getTrackedThreadLoadingCopy(tab)}
  <LoadingState title={loadingCopy.title} message={loadingCopy.message} />
{:else if error && items.length === 0}
  <ErrorState
    title={getTrackedThreadErrorTitle(tab)}
    message={error.message}
    detail={error.status > 0
      ? `${error.method} ${error.path || "/api"} -> ${error.status}`
      : `${error.method} ${error.path || "/api"} -> ${error.code ?? "NETWORK_ERROR"}`}
  />
{:else if items.length === 0}
  <p class="empty-state">{emptyMessage}</p>
{:else}
  <div class="tracked-thread-panel">
    {#if error}
      <div class="inline-error" role="status" aria-live="polite">
        <span>{error.message}</span>
      </div>
    {/if}

    <ul class="tracked-threads-list">
      {#each items as thread (thread.thread_id)}
        <li class="thread-item">
          <div class="thread-header">
            <a
              href={getTrackedThreadResumeUrl(thread)}
              class="thread-subject"
              class:has-unread={thread.has_unread}
              on:click={(event) => onLinkClick(event, getTrackedThreadResumeUrl(thread))}
            >{thread.subject ?? "(No subject)"}</a>

            <span class:unread={thread.has_unread} class="thread-state">
              {thread.has_unread ? `${thread.unread_count} unread` : "Caught up"}
            </span>
          </div>

          <div class="thread-meta">
            <span class="thread-list-name">{thread.list_name}</span>
            <span class="thread-activity-label">Last activity</span>
            <span class="thread-activity">{formatDateTime(thread.last_activity_at)}</span>
          </div>
        </li>
      {/each}
    </ul>

    {#if nextCursor}
      <div class="load-more">
        <button
          type="button"
          class="primary-button"
          disabled={loadingMore}
          on:click={handleLoadMore}
        >{loadingMore ? "Loading..." : "Load more"}</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .tracked-thread-panel {
    display: grid;
    gap: 0.75rem;
  }

  .inline-error {
    display: inline-flex;
    align-items: center;
    padding: 0.6rem 0.8rem;
    border: 1px solid #f2d58a;
    border-radius: 0.8rem;
    background: #fff7df;
    color: #8b6200;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .empty-state {
    margin: 0;
    color: #627d98;
    font-size: 0.92rem;
  }

  .tracked-threads-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0;
  }

  .thread-item {
    display: grid;
    gap: 0.55rem;
    padding: 0.8rem 0;
    border-bottom: 1px solid #e8edf3;
  }

  .thread-item:last-child {
    border-bottom: none;
  }

  .thread-header {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  .thread-subject {
    color: #334e68;
    font-size: 0.95rem;
    line-height: 1.4;
    text-decoration: none;
    word-break: break-word;
  }

  .thread-subject:hover {
    color: #0b4ea2;
    text-decoration: underline;
  }

  .thread-subject.has-unread {
    color: #102a43;
    font-weight: 700;
  }

  .thread-state {
    display: inline-flex;
    align-items: center;
    min-height: 1.5rem;
    padding: 0.16rem 0.55rem;
    border-radius: 999px;
    background: #eef2f7;
    color: #486581;
    font-size: 0.76rem;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }

  .thread-state.unread {
    background: #0b4ea2;
    color: #fff;
  }

  .thread-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .thread-list-name,
  .thread-activity,
  .thread-activity-label {
    font-size: 0.8rem;
  }

  .thread-list-name {
    color: #627d98;
  }

  .thread-activity-label {
    color: #829ab1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .thread-activity {
    color: #486581;
  }

  .primary-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2rem;
    padding: 0.42rem 0.82rem;
    border-radius: 999px;
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1;
    text-decoration: none;
  }

  .primary-button {
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .primary-button:hover {
    background: #dcebff;
  }

  .primary-button {
    cursor: pointer;
    font: inherit;
  }

  .primary-button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .load-more {
    display: flex;
    justify-content: center;
    padding-top: 0.25rem;
  }
</style>
