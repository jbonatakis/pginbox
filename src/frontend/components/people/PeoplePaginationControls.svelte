<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let hasNextPage = false;
  export let hasPreviousPage = false;
  export let isBusy = false;
  export let limit = 25;
  export let limitOptions: number[] = [10, 25, 50, 100];
  export let pageNumber = 1;

  const dispatch = createEventDispatcher<{
    limitchange: number;
    next: void;
    previous: void;
  }>();

  const emitPrevious = (): void => {
    dispatch("previous");
  };

  const emitNext = (): void => {
    dispatch("next");
  };

  const emitLimitChange = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;

    const parsed = Number(target.value);
    if (Number.isNaN(parsed) || !Number.isInteger(parsed)) return;
    dispatch("limitchange", parsed);
  };
</script>

<section class="controls" aria-label="People pagination">
  <div class="limit-control">
    <label for="people-limit">Per page</label>
    <select id="people-limit" value={limit} disabled={isBusy} on:change={emitLimitChange}>
      {#each limitOptions as option}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </div>

  <p class="page-indicator" aria-live="polite">Page {pageNumber}</p>

  <div class="page-actions">
    <button type="button" disabled={!hasPreviousPage || isBusy} on:click={emitPrevious}>Previous</button>
    <button type="button" disabled={!hasNextPage || isBusy} on:click={emitNext}>Next</button>
  </div>
</section>

<style>
  .controls {
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface-soft);
    padding: 0.55rem 0.68rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .limit-control {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .limit-control label {
    font-size: 0.82rem;
    color: var(--text-muted);
    font-weight: 600;
  }

  select {
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: #fff;
    color: var(--text);
    font-size: 0.84rem;
    font-weight: 600;
    padding: 0.26rem 0.4rem;
  }

  .page-indicator {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.84rem;
    font-weight: 650;
  }

  .page-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  button {
    border: 1px solid rgba(111, 159, 221, 0.76);
    border-radius: 0.45rem;
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 650;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.36rem 0.55rem;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
