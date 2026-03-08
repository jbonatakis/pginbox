<script lang="ts">
  import type { AnalyticsTopSenderPoint } from "../../lib/analytics";

  export let senders: AnalyticsTopSenderPoint[] = [];
  export let emptyMessage = "No sender activity has been recorded yet.";

  const numberFormatter = new Intl.NumberFormat("en-US");
  const formatCount = (value: number): string => numberFormatter.format(value);

  const senderLabel = (sender: AnalyticsTopSenderPoint): string => {
    const name = sender.name?.trim() || null;
    const email = sender.email?.trim() || null;

    if (name && email && name !== email) {
      return `${name} (${email})`;
    }

    return name ?? email ?? "Unknown sender";
  };

  $: hasSenders = senders.length > 0;
</script>

<article class="card">
  <h3>Top Senders</h3>

  {#if hasSenders}
    <ol class="sender-list">
      {#each senders as sender (sender.rank)}
        <li>
          <span>{senderLabel(sender)}</span>
          <strong>{formatCount(sender.messages)}</strong>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty-message">{emptyMessage}</p>
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

  .sender-list {
    margin: 0;
    padding-left: 1.15rem;
    display: grid;
    gap: 0.3rem;
  }

  .sender-list li {
    padding-left: 0.2rem;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    color: #334e68;
    font-size: 0.86rem;
    border-bottom: 1px dashed #d9e2ec;
    padding-bottom: 0.2rem;
    min-width: 0;
  }

  .sender-list li span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .sender-list li strong {
    color: #102a43;
    line-height: 1.2;
  }

  .empty-message {
    margin: 0;
    color: #627d98;
    font-size: 0.88rem;
    line-height: 1.35;
  }
</style>
