<script lang="ts">
  import type { Message } from "shared/api";
  import ThreadTimelineItem from "./ThreadTimelineItem.svelte";

  export let messages: Message[] = [];
  const numberFormatter = new Intl.NumberFormat("en-US");

  const messageCountLabel = (count: number): string => {
    if (count === 1) return "1 message in chronological order.";
    return `${numberFormatter.format(count)} messages in chronological order.`;
  };

  const anchorToken = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const messageAnchorId = (message: Message, index: number): string => {
    const token = anchorToken(message.id);
    if (token.length > 0) return `message-${token}-${index + 1}`;
    return `message-${index + 1}`;
  };
</script>

<section class="timeline" aria-label="Thread message timeline">
  <header class="timeline-header">
    <h3>Messages</h3>
    <p>{messageCountLabel(messages.length)}</p>
  </header>

  {#if messages.length === 0}
    <p class="empty-message">No messages are available for this thread.</p>
  {:else}
    <nav class="jump-nav" aria-label="Jump to message">
      <ol>
        {#each messages as message, index (`${message.id}:${index}`)}
          {@const anchorId = messageAnchorId(message, index)}
          <li>
            <a href={`#${anchorId}`}>#{index + 1}</a>
          </li>
        {/each}
      </ol>
    </nav>

    <ol class="timeline-list">
      {#each messages as message, index (`${message.id}:${index}`)}
        {@const anchorId = messageAnchorId(message, index)}
        <li>
          <ThreadTimelineItem {message} {index} {anchorId} />
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

  .jump-nav {
    min-width: 0;
  }

  .jump-nav ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    min-width: 0;
  }

  .jump-nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.05rem;
    padding: 0.2rem 0.4rem;
    border-radius: 999px;
    border: 1px solid #bcccdc;
    text-decoration: none;
    color: #243b53;
    font-size: 0.78rem;
    line-height: 1;
    background: #f0f7ff;
  }

  .jump-nav a:hover {
    border-color: #9fb3c8;
    background: #e8f2ff;
    color: #102a43;
  }

  .jump-nav a:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .timeline-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }
</style>
