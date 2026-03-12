<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let currentPage = 1;
  export let isBusy = false;
  export let pageSummary = "";
  export let rangeSummary: string | null = null;
  export let selectId = "thread-page-select";
  export let totalPages = 1;

  const dispatch = createEventDispatcher<{
    first: void;
    previous: void;
    pagechange: number;
    next: void;
    last: void;
  }>();

  const pageOptions = (): number[] => Array.from({ length: totalPages }, (_, index) => index + 1);

  const emitFirst = (): void => {
    dispatch("first");
  };

  const emitPrevious = (): void => {
    dispatch("previous");
  };

  const emitNext = (): void => {
    dispatch("next");
  };

  const emitLast = (): void => {
    dispatch("last");
  };

  const emitPageChange = (event: Event): void => {
    const value = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(value)) return;
    dispatch("pagechange", Math.trunc(value));
  };
</script>

<section class="page-controls" aria-label="Thread message pages">
  <div class="page-controls-copy">
    <p>{pageSummary}</p>
    {#if rangeSummary}
      <p>{rangeSummary}</p>
    {/if}
  </div>

  <div class="page-controls-actions">
    <button type="button" disabled={isBusy || currentPage <= 1} on:click={emitFirst}>First</button>
    <button type="button" disabled={isBusy || currentPage <= 1} on:click={emitPrevious}
      >Previous</button
    >

    {#if totalPages > 1}
      <label class="page-select" for={selectId}>
        <span>Page</span>
        <select id={selectId} value={currentPage} disabled={isBusy} on:change={emitPageChange}>
          {#each pageOptions() as pageNumber}
            <option value={pageNumber}>
              Page {pageNumber}
              {pageNumber === 1 ? " (oldest)" : pageNumber === totalPages ? " (latest)" : ""}
            </option>
          {/each}
        </select>
      </label>
    {/if}

    <button type="button" disabled={isBusy || currentPage >= totalPages} on:click={emitNext}
      >Next</button
    >
    <button type="button" disabled={isBusy || currentPage >= totalPages} on:click={emitLast}>Last</button>
  </div>
</section>

<style>
  .page-controls {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    min-width: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .page-controls-copy {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  p {
    margin: 0;
    color: #486581;
    line-height: 1.4;
    min-width: 0;
  }

  .page-controls-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  button,
  .page-select select {
    border: 1px solid #6f9fdd;
    border-radius: 0.55rem;
    background: #e8f2ff;
    color: #0b4ea2;
    font-weight: 650;
    font-size: 0.86rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }

  button:disabled,
  .page-select select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .page-select {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #486581;
    font-weight: 600;
  }

  .page-select span {
    white-space: nowrap;
  }

  .page-select select {
    padding-right: 2rem;
  }

  @media (max-width: 640px) {
    .page-controls-actions {
      width: 100%;
    }

    button,
    .page-select {
      width: 100%;
    }

    .page-select {
      display: grid;
      gap: 0.3rem;
    }

    .page-select select {
      width: 100%;
    }
  }
</style>
