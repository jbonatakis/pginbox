<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let hasActiveCursor = false;
  export let hasPreviousPage = false;
  export let hasNextPage = false;
  export let isBusy = false;
  export let regionLabel = "Thread pagination";
  export let statusLive = true;

  const dispatch = createEventDispatcher<{
    next: void;
    previous: void;
    reset: void;
  }>();

  const emitNext = (): void => {
    dispatch("next");
  };

  const emitPrevious = (): void => {
    dispatch("previous");
  };

  const emitReset = (): void => {
    dispatch("reset");
  };
</script>

<section class="controls" aria-label={regionLabel}>
  <p aria-live={statusLive ? "polite" : "off"}>
    {#if hasActiveCursor}
      Viewing a paged result window.
    {:else}
      Viewing the first result window.
    {/if}
  </p>

  <div class="actions">
    <button type="button" disabled={!hasActiveCursor || isBusy} on:click={emitReset}>First page</button>
    <button type="button" disabled={!hasPreviousPage || isBusy} on:click={emitPrevious}>
      Previous page
    </button>
    <button type="button" disabled={!hasNextPage || isBusy} on:click={emitNext}>Next page</button>
  </div>
</section>

<style>
  .controls {
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface-soft);
    padding: 0.54rem 0.68rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  p {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .actions {
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
    opacity: 0.65;
    cursor: not-allowed;
  }
</style>
