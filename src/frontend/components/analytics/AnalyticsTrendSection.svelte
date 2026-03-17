<script lang="ts">
  export interface TrendRow {
    id: string;
    label: string;
    messages: number;
  }

  export let title = "";
  export let rows: TrendRow[] = [];
  export let emptyMessage = "No trend data has been recorded yet.";
  export let hasData: boolean | null = null;
  export let dense = false;

  const numberFormatter = new Intl.NumberFormat("en-US");
  const formatCount = (value: number): string => numberFormatter.format(value);

  $: shouldRenderRows = (hasData ?? rows.length > 0) && rows.length > 0;
</script>

<article class="card">
  <h3>{title}</h3>

  {#if shouldRenderRows}
    <ul class="data-list" class:dense>
      {#each rows as row (row.id)}
        <li>
          <span>{row.label}</span>
          <strong>{formatCount(row.messages)}</strong>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-message">{emptyMessage}</p>
  {/if}
</article>

<style>
  .card {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-soft);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.96rem;
    color: var(--text);
  }

  .data-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .data-list li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    color: var(--text-subtle);
    font-size: 0.86rem;
    border-bottom: 1px dashed var(--border);
    padding-bottom: 0.2rem;
    min-width: 0;
  }

  .data-list li span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .data-list li strong {
    color: var(--text);
    line-height: 1.2;
  }

  .data-list.dense {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 6.8rem), 1fr));
    column-gap: 0.6rem;
    row-gap: 0.45rem;
  }

  .data-list.dense li {
    border-bottom: none;
    border-radius: 0.45rem;
    border: 1px solid var(--border);
    padding: 0.35rem 0.42rem;
    background: var(--surface-muted);
    display: grid;
    gap: 0.15rem;
  }

  .empty-message {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.88rem;
    line-height: 1.35;
  }
</style>
