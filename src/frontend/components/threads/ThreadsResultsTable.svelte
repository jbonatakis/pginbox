<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { Thread } from "shared/api";
  import { withThreadsRestoreScroll } from "../../lib/state/threadsQuery";
  import { isClientNavigationEvent, onLinkClick, threadDetailPath } from "../../router";

  export let contextSearch = "";
  export let items: Thread[] = [];
  export let canManageFollows = false;
  export let pendingThreadIds: string[] = [];

  const dispatch = createEventDispatcher<{
    togglefollow: {
      isFollowed: boolean;
      threadId: string;
    };
  }>();

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const messageCountFormatter = new Intl.NumberFormat("en-US");

  const subjectLabel = (subject: string | null): string => {
    const normalized = subject?.trim() ?? "";
    return normalized.length > 0 ? normalized : "(No subject)";
  };

  const listLabel = (name: string): string => {
    const normalized = name.trim();
    return normalized.length > 0 ? normalized : "Unknown list";
  };

  const formatDateTime = (value: string | null): string => {
    if (!value) return "Unknown";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return dateFormatter.format(parsed);
  };

  const currentScrollY = (): number | undefined => {
    if (typeof window === "undefined") return undefined;
    return Math.max(0, Math.trunc(window.scrollY));
  };

  const threadPath = (threadId: string, includeScrollContext = false): string => {
    const search = includeScrollContext
      ? withThreadsRestoreScroll(contextSearch, currentScrollY())
      : contextSearch;
    return `${threadDetailPath(threadId)}${search}`;
  };

  const persistCurrentListContext = (): void => {
    if (typeof window === "undefined") return;

    const nextSearch = withThreadsRestoreScroll(contextSearch, currentScrollY());
    const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  };

  const handleThreadClick = (event: MouseEvent, threadId: string): void => {
    if (!isClientNavigationEvent(event)) return;

    persistCurrentListContext();
    onLinkClick(event, threadPath(threadId, true));
  };

  const isFollowPending = (threadId: string): boolean => pendingThreadIds.includes(threadId);
  const hasKnownFollowState = (thread: Thread): boolean => typeof thread.is_followed === "boolean";

  const handleFollowClick = (event: MouseEvent, thread: Thread): void => {
    event.preventDefault();
    event.stopPropagation();
    dispatch("togglefollow", {
      threadId: thread.thread_id,
      isFollowed: thread.is_followed === true,
    });
  };

  const followButtonLabel = (thread: Thread): string =>
    !hasKnownFollowState(thread)
      ? "Loading follow state"
      : thread.is_followed === true
        ? "Unfollow thread"
        : "Follow thread";
</script>

<div class="table-wrap">
  <table class="results" aria-label="Thread results">
    <thead>
      <tr>
        <th scope="col">Subject</th>
        <th scope="col">List</th>
        <th scope="col">Last activity</th>
        <th scope="col" class="numeric">Messages</th>
        {#if canManageFollows}
          <th scope="col" class="follow-column">Follow</th>
        {/if}
      </tr>
    </thead>

    <tbody>
      {#each items as thread (thread.thread_id)}
        {@const path = threadPath(thread.thread_id)}
        <tr>
          <td class="subject" data-label="Subject">
            <div class="subject-row">
              <a href={path} on:click={(event) => handleThreadClick(event, thread.thread_id)}
                >{subjectLabel(thread.subject)}</a
              >
              {#if canManageFollows && thread.is_followed === true}
                <span class="follow-badge">Followed</span>
              {/if}
            </div>
          </td>
          <td data-label="List">{listLabel(thread.list_name)}</td>
          <td data-label="Last activity">{formatDateTime(thread.last_activity_at)}</td>
          <td class="numeric" data-label="Messages">{messageCountFormatter.format(thread.message_count)}</td>
          {#if canManageFollows}
            <td class="follow-cell" data-label="Follow">
              <button
                type="button"
                aria-pressed={thread.is_followed === true}
                aria-label={followButtonLabel(thread)}
                title={!hasKnownFollowState(thread) ? "Loading follow state" : thread.is_followed === true ? "Following" : "Follow"}
                class:followed={thread.is_followed === true}
                class="follow-button"
                disabled={isFollowPending(thread.thread_id) || !hasKnownFollowState(thread)}
                on:click={(event) => handleFollowClick(event, thread)}
              >
                {#if isFollowPending(thread.thread_id) || !hasKnownFollowState(thread)}
                  <span class="follow-pending" aria-hidden="true"></span>
                {:else}
                  <svg
                    viewBox="0 0 20 20"
                    class:filled={thread.is_followed === true}
                    class="follow-icon"
                    aria-hidden="true"
                  >
                    <path d="M10 2.3 12.4 7.1 17.7 7.9 13.9 11.6 14.8 16.9 10 14.4 5.2 16.9 6.1 11.6 2.3 7.9 7.6 7.1 10 2.3Z"></path>
                  </svg>
                {/if}
              </button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-soft);
    overflow-x: auto;
  }

  .results {
    width: 100%;
    border-collapse: collapse;
    min-width: 32rem;
  }

  th,
  td {
    text-align: left;
    padding: 0.58rem 0.72rem;
    border-bottom: 1px solid var(--border-soft);
    vertical-align: top;
  }

  thead th {
    font-size: 0.76rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    white-space: nowrap;
    background: var(--surface-muted);
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr:hover td {
    background: var(--surface-muted);
  }

  td {
    font-size: 0.88rem;
    color: var(--text-subtle);
    line-height: 1.35;
  }

  .subject {
    min-width: 0;
  }

  .subject-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex-wrap: wrap;
  }

  .subject a {
    color: var(--primary);
    font-weight: 650;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
  }

  .follow-badge {
    display: inline-flex;
    align-items: center;
    min-height: 1.35rem;
    padding: 0.12rem 0.5rem;
    border: 1px solid rgba(11, 78, 162, 0.22);
    border-radius: 999px;
    background: var(--primary-soft);
    color: var(--primary);
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }

  .subject a:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
    border-radius: 0.15rem;
  }

  .numeric {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .follow-column,
  .follow-cell {
    text-align: right;
    white-space: nowrap;
  }

  .follow-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.95rem;
    height: 1.95rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    line-height: 1;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .follow-button.followed {
    border-color: rgba(11, 78, 162, 0.34);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .follow-button:hover {
    border-color: var(--border);
    background: rgba(255, 255, 255, 0.92);
    color: var(--primary);
  }

  .follow-button.followed:hover {
    border-color: rgba(11, 78, 162, 0.34);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .follow-button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .follow-button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .follow-icon {
    width: 0.95rem;
    height: 0.95rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.65;
    stroke-linejoin: round;
  }

  .follow-icon.filled {
    fill: currentColor;
  }

  .follow-pending {
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 999px;
    animation: follow-spin 720ms linear infinite;
  }

  @keyframes follow-spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 760px) {
    .results {
      min-width: 0;
      border-collapse: separate;
      border-spacing: 0;
    }

    .results thead {
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      height: 1px;
      margin: -1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
      width: 1px;
    }

    .results tbody {
      display: grid;
      gap: 0.45rem;
      padding: 0.55rem;
    }

    .results tr {
      display: grid;
      gap: 0.35rem;
      border: 1px solid var(--border);
      border-radius: 0.6rem;
      background: var(--surface-muted);
      padding: 0.5rem 0.6rem;
    }

    .results td {
      border: none;
      padding: 0;
      display: grid;
      grid-template-columns: minmax(0, 6.6rem) minmax(0, 1fr);
      align-items: baseline;
      gap: 0.5rem;
    }

    .results td::before {
      content: attr(data-label);
      color: var(--text-muted);
      font-size: 0.71rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 700;
    }

    .results td.numeric {
      text-align: left;
      white-space: normal;
    }

    .results td.follow-cell {
      text-align: left;
    }

    .follow-button {
      justify-self: start;
    }

    .results tbody tr:hover td {
      background: transparent;
    }
  }
</style>
