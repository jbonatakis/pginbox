<script lang="ts">
  import type { Thread } from "shared/api";
  import { withThreadsRestoreScroll } from "../../lib/state/threadsQuery";
  import { isClientNavigationEvent, onLinkClick, threadDetailPath } from "../../router";

  export let contextSearch = "";
  export let items: Thread[] = [];

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
</script>

<div class="table-wrap">
  <table class="results" aria-label="Thread results">
    <thead>
      <tr>
        <th scope="col">Subject</th>
        <th scope="col">List</th>
        <th scope="col">Last activity</th>
        <th scope="col" class="numeric">Messages</th>
      </tr>
    </thead>

    <tbody>
      {#each items as thread (thread.thread_id)}
        {@const path = threadPath(thread.thread_id)}
        <tr>
          <td class="subject" data-label="Subject">
            <a href={path} on:click={(event) => handleThreadClick(event, thread.thread_id)}
              >{subjectLabel(thread.subject)}</a
            >
          </td>
          <td data-label="List">{listLabel(thread.list_name)}</td>
          <td data-label="Last activity">{formatDateTime(thread.last_activity_at)}</td>
          <td class="numeric" data-label="Messages">{messageCountFormatter.format(thread.message_count)}</td>
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

  .subject a {
    color: var(--primary);
    font-weight: 650;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
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

    .results tbody tr:hover td {
      background: transparent;
    }
  }
</style>
