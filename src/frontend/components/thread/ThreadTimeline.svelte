<script lang="ts">
  import type { MessageWithAttachments } from "shared/api";
  import { onDestroy, onMount } from "svelte";
  import ThreadTimelineItem from "./ThreadTimelineItem.svelte";
  import { api } from "../../lib/api";
  import { currentRoute } from "../../router";

  type TimelineEntry = {
    key: string;
    message: MessageWithAttachments;
    absoluteIndex: number;
    anchorId: string;
    isCollapsed: boolean;
  };

  export let messages: MessageWithAttachments[] = [];
  export let startIndex = 0;
  export let totalCount: number | null = null;
  export let firstUnreadMessageId: string | null = null;
  export let threadId: string | null = null;
  export let isAuthenticated: boolean = false;

  const numberFormatter = new Intl.NumberFormat("en-US");
  let collapsedMessages: Record<string, boolean> = {};

  // Read tracking
  let hwmMessageId: string | null = null;
  let hwmAbsoluteIndex = -1;
  let lastFlushedMessageId: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
  const observedEntries = new Map<Element, TimelineEntry>();

  const flushProgress = (): void => {
    if (!threadId || !isAuthenticated || !hwmMessageId) return;
    if (hwmMessageId === lastFlushedMessageId) return;
    const messageId = hwmMessageId;
    lastFlushedMessageId = messageId;
    void api.threads.advanceProgress(threadId, messageId).catch(() => {});
  };

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushProgress();
    }, 2000);
  };

  const maybeAdvanceHwm = (messageId: string, absoluteIndex: number): void => {
    if (absoluteIndex > hwmAbsoluteIndex) {
      hwmMessageId = messageId;
      hwmAbsoluteIndex = absoluteIndex;
      scheduleFlush();
    }
  };

  const onIntersect = (ioEntries: IntersectionObserverEntry[]): void => {
    for (const ioEntry of ioEntries) {
      if (!ioEntry.isIntersecting) continue;
      const entry = observedEntries.get(ioEntry.target);
      if (!entry || entry.isCollapsed) continue;
      maybeAdvanceHwm(entry.message.id, entry.absoluteIndex);
    }
  };

  const observeMessage = (node: HTMLElement, entry: TimelineEntry) => {
    observedEntries.set(node, entry);
    observer?.observe(node);
    return {
      update(newEntry: TimelineEntry) {
        observedEntries.set(node, newEntry);
      },
      destroy() {
        observedEntries.delete(node);
        observer?.unobserve(node);
      },
    };
  };

  const messageCountLabel = (count: number): string => {
    if (count === 0) return "No messages are available for this page.";

    if (totalCount !== null) {
      const start = startIndex + 1;
      const end = startIndex + count;
      if (start === end) {
        return `Showing message ${numberFormatter.format(start)} of ${numberFormatter.format(totalCount)} in chronological order.`;
      }
      return `Showing messages ${numberFormatter.format(start)}-${numberFormatter.format(end)} of ${numberFormatter.format(totalCount)} in chronological order.`;
    }
    if (count === 1) return "1 message in chronological order.";
    return `${numberFormatter.format(count)} messages in chronological order.`;
  };

  const messageAnchorId = (message: MessageWithAttachments): string => `message-${message.id}`;

  const messageEntryKey = (message: MessageWithAttachments, absoluteIndex: number): string =>
    `${message.id}:${absoluteIndex}`;

  const toggleMessageCollapsed = (entry: TimelineEntry): void => {
    const wasCollapsed = entry.isCollapsed;
    collapsedMessages = {
      ...collapsedMessages,
      [entry.key]: !wasCollapsed,
    };
    // If expanding and isAuthenticated, check if element is already in viewport
    if (wasCollapsed && isAuthenticated) {
      const el = document.getElementById(entry.anchorId);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          maybeAdvanceHwm(entry.message.id, entry.absoluteIndex);
        }
      }
    }
  };

  const setAllMessagesCollapsed = (entries: TimelineEntry[], collapsed: boolean): void => {
    const nextState = { ...collapsedMessages };

    for (const entry of entries) {
      nextState[entry.key] = collapsed;
    }

    collapsedMessages = nextState;
  };

  onMount(() => {
    if (isAuthenticated && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(onIntersect, { threshold: 0.5 });
      for (const el of observedEntries.keys()) {
        observer.observe(el);
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        clearFlushTimer();
        flushProgress();
      }
    };

    const handleBeforeUnload = (): void => {
      clearFlushTimer();
      flushProgress();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    let initialRouteSkipped = false;
    const unsubscribeRoute = currentRoute.subscribe(() => {
      if (!initialRouteSkipped) {
        initialRouteSkipped = true;
        return;
      }
      clearFlushTimer();
      flushProgress();
    });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unsubscribeRoute();
      clearFlushTimer();
      observer?.disconnect();
      observer = null;
      observedEntries.clear();
    };
  });

  onDestroy(() => {
    flushProgress();
  });

  $: timelineEntries = messages.map((message, index) => {
    const absoluteIndex = startIndex + index;
    const key = messageEntryKey(message, absoluteIndex);
    return {
      key,
      message,
      absoluteIndex,
      anchorId: messageAnchorId(message),
      isCollapsed: collapsedMessages[key] ?? false,
    } satisfies TimelineEntry;
  });

  $: areAllMessagesCollapsed = timelineEntries.length > 0 && timelineEntries.every((entry) => entry.isCollapsed);

  $: collapseAllLabel = areAllMessagesCollapsed ? "Expand all" : "Collapse all";
</script>

<section class="timeline" aria-label="Thread message timeline">
  <header class="timeline-header">
    <div class="timeline-title-row">
      <h3>Messages</h3>

      {#if messages.length > 0}
        <button
          class="collapse-all-toggle"
          type="button"
          on:click={() => setAllMessagesCollapsed(timelineEntries, !areAllMessagesCollapsed)}
        >
          {collapseAllLabel}
        </button>
      {/if}
    </div>

    <p>{messageCountLabel(messages.length)}</p>
  </header>

  {#if messages.length === 0}
    <p class="empty-message">No messages are available for this thread.</p>
  {:else}
    <ol class="timeline-list">
      {#each timelineEntries as entry (entry.key)}
        {#if firstUnreadMessageId !== null && entry.message.id === firstUnreadMessageId}
          <li class="unread-divider" aria-label="New since your last visit">
            <span class="unread-divider-label">New since your last visit</span>
          </li>
        {/if}
        <li use:observeMessage={entry}>
          <ThreadTimelineItem
            message={entry.message}
            index={entry.absoluteIndex}
            anchorId={entry.anchorId}
            isCollapsed={entry.isCollapsed}
            on:toggle={() => toggleMessageCollapsed(entry)}
          />
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .timeline {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.6rem;
    min-width: 0;
  }

  .timeline-header {
    display: grid;
    gap: 0.12rem;
    min-width: 0;
  }

  .timeline-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.97rem;
    color: #102a43;
    line-height: 1.3;
  }

  p {
    margin: 0;
    color: #486581;
    line-height: 1.35;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .empty-message {
    color: #627d98;
  }

  .collapse-all-toggle {
    border: 1px solid #bcccdc;
    border-radius: 999px;
    background: #ffffff;
    color: #334e68;
    font-size: 0.8rem;
    font-weight: 700;
    line-height: 1;
    padding: 0.45rem 0.75rem;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      color 120ms ease,
      background-color 120ms ease;
  }

  .collapse-all-toggle:hover {
    border-color: #9fb3c8;
    background: #f0f7ff;
    color: #102a43;
  }

  .collapse-all-toggle:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    .timeline-title-row {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }

  .timeline-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .unread-divider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: #0b4ea2;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .unread-divider::before,
  .unread-divider::after {
    content: "";
    flex: 1;
    height: 2px;
    background: #0b4ea2;
    border-radius: 1px;
    opacity: 0.35;
  }
</style>
