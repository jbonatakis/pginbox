<script lang="ts">
  import type { PersonTopThread } from "shared/api";
  import { onLinkClick, threadDetailPath } from "../../router";

  export let topThreads: PersonTopThread[] = [];

  const numberFormatter = new Intl.NumberFormat("en-US");
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const threadPath = (threadId: string): string => threadDetailPath(threadId);

  const threadSubject = (subject: string | null): string => {
    const normalized = subject?.trim() ?? "";
    return normalized.length > 0 ? normalized : "(No subject)";
  };

  const messageLabel = (count: number): string =>
    count === 1 ? "1 message" : `${numberFormatter.format(count)} messages`;

  const lastActivityLabel = (value: string | null): string => {
    if (!value) return "Last activity unknown";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Last activity unknown";

    return `Last activity ${dateFormatter.format(parsed)}`;
  };
</script>

<article class="card" aria-label="Top threads">
  <h3>Top threads</h3>

  {#if topThreads.length > 0}
    <ol class="thread-list">
      {#each topThreads as thread (thread.thread_id)}
        {@const path = threadPath(thread.thread_id)}
        <li>
          <a class="thread-row" href={path} on:click={(event) => onLinkClick(event, path)}>
            <strong>{threadSubject(thread.subject)}</strong>
            <span>{messageLabel(thread.message_count)}</span>
            <span>{lastActivityLabel(thread.last_activity_at)}</span>
          </a>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty-message">No thread activity has been recorded for this contributor yet.</p>
  {/if}
</article>

<style>
  .card {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.96rem;
    color: #102a43;
  }

  .thread-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.45rem;
    min-width: 0;
  }

  .thread-row {
    display: grid;
    gap: 0.15rem;
    margin: 0;
    padding: 0.5rem 0.55rem;
    border-radius: 0.55rem;
    border: 1px solid #d9e2ec;
    background: #f8fbff;
    text-decoration: none;
    min-width: 0;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease;
  }

  .thread-row:hover {
    border-color: #9fb3c8;
    background: #f0f7ff;
    box-shadow: 0 0 0 2px rgba(159, 179, 200, 0.18);
  }

  .thread-row:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .thread-row strong {
    color: #102a43;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  .thread-row span {
    color: #486581;
    font-size: 0.81rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .empty-message {
    margin: 0;
    color: #627d98;
    font-size: 0.88rem;
    line-height: 1.35;
  }
</style>
