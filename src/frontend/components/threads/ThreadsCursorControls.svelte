<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let hasActiveCursor = false;
  export let hasPreviousPage = false;
  export let hasNextPage = false;
  export let isBusy = false;

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

<section class="controls" aria-label="Thread pagination">
  <p aria-live="polite">
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
    border: 1px solid #d9e2ec;
    border-radius: 0.65rem;
    background: rgba(255, 255, 255, 0.9);
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
    color: #486581;
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  button {
    border: 1px solid #6f9fdd;
    border-radius: 0.45rem;
    background: #e8f2ff;
    color: #0b4ea2;
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
