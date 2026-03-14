<script lang="ts">
  import type { List } from "shared/api";
  import { createEventDispatcher } from "svelte";
  import { THREADS_QUERY_DEFAULT_LIMIT } from "../../lib/state/threadsQuery";

  export let fromDate = "";
  export let defaultLimit = THREADS_QUERY_DEFAULT_LIMIT;
  export let isBusy = false;
  export let isListsLoading = false;
  export let limit = 25;
  export let limitOptions: number[] = [10, 25, 50, 100];
  export let listOptions: List[] = [];
  export let listsErrorMessage: string | null = null;
  export let searchQuery = "";
  export let selectedList: string | undefined;
  export let toDate = "";

  const dispatch = createEventDispatcher<{
    retrylists: void;
    searchsubmit: {
      from: string | null;
      limit: number;
      list: string | null;
      q: string | null;
      to: string | null;
    };
  }>();

  let searchDraft = searchQuery;
  let selectedListDraft = selectedList ?? "";
  let fromDateDraft = fromDate;
  let toDateDraft = toDate;
  let limitDraft = limit;
  let lastSyncedFilterState = "";

  const normalizedDraftText = (value: string): string | null => {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  };

  const serializeFilterState = (): string =>
    JSON.stringify({
      fromDate,
      limit,
      searchQuery,
      selectedList: selectedList ?? null,
      toDate,
    });

  $: {
    const nextSyncedFilterState = serializeFilterState();
    if (nextSyncedFilterState === lastSyncedFilterState) {
      // No applied-filter change to sync into the local draft state.
    } else {
      lastSyncedFilterState = nextSyncedFilterState;
      fromDateDraft = fromDate;
      limitDraft = limit;
      searchDraft = searchQuery;
      selectedListDraft = selectedList ?? "";
      toDateDraft = toDate;
    }
  }

  $: hasUnknownSelectedList =
    selectedListDraft.length > 0 &&
    !listOptions.some((candidate) => candidate.name === selectedListDraft);
  $: hasModifiedFilters =
    searchDraft !== "" ||
    selectedListDraft !== "" ||
    fromDateDraft !== "" ||
    toDateDraft !== "" ||
    Number(limitDraft) !== defaultLimit;

  const emitClear = (): void => {
    fromDateDraft = "";
    limitDraft = defaultLimit;
    searchDraft = "";
    selectedListDraft = "";
    toDateDraft = "";
  };

  const emitRetryLists = (): void => {
    dispatch("retrylists");
  };

  const emitSearchSubmit = (): void => {
    const parsedLimit = Number(limitDraft);

    dispatch("searchsubmit", {
      from: normalizedDraftText(fromDateDraft),
      limit: Number.isInteger(parsedLimit) ? parsedLimit : limit,
      list: normalizedDraftText(selectedListDraft),
      q: normalizedDraftText(searchDraft),
      to: normalizedDraftText(toDateDraft),
    });
  };
</script>

<form class="filters" aria-label="Thread filters" on:submit|preventDefault={emitSearchSubmit}>
  <div class="field search-field">
    <label for="threads-search">Search threads</label>
    <div class="search-form">
      <input
        id="threads-search"
        type="search"
        bind:value={searchDraft}
        placeholder="Search threads"
        disabled={isBusy}
      />
      <button type="submit" class="search-button" disabled={isBusy}>Search</button>
    </div>
  </div>

  <div class="field list-field">
    <label for="threads-list">List</label>
    <select
      id="threads-list"
      bind:value={selectedListDraft}
      disabled={isBusy || isListsLoading}
    >
      <option value="">All lists</option>
      {#if hasUnknownSelectedList}
        <option value={selectedListDraft}>{selectedListDraft} (Unavailable)</option>
      {/if}
      {#each listOptions as list (list.id)}
        <option value={list.name}>{list.name}</option>
      {/each}
    </select>

    {#if isListsLoading}
      <p class="field-note" role="status">Loading list options...</p>
    {:else if listsErrorMessage}
      <div class="field-error" role="alert">
        <p>{listsErrorMessage}</p>
        <button type="button" on:click={emitRetryLists} disabled={isBusy}>Retry lists</button>
      </div>
    {/if}
  </div>

  <div class="field">
    <label for="threads-from">From</label>
    <input
      id="threads-from"
      type="date"
      bind:value={fromDateDraft}
      max={toDateDraft || undefined}
      disabled={isBusy}
    />
  </div>

  <div class="field">
    <label for="threads-to">To</label>
    <input
      id="threads-to"
      type="date"
      bind:value={toDateDraft}
      min={fromDateDraft || undefined}
      disabled={isBusy}
    />
  </div>

  <div class="field">
    <label for="threads-limit">Limit</label>
    <select id="threads-limit" bind:value={limitDraft} disabled={isBusy}>
      {#each limitOptions as option}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </div>

  <div class="actions">
    <button
      type="button"
      class="clear-button"
      class:modified={hasModifiedFilters}
      disabled={isBusy}
      on:click={emitClear}
      >Clear filters</button
    >
  </div>
</form>

<style>
  .filters {
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.7rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.65rem;
    align-items: start;
  }

  .field {
    min-width: 0;
    display: grid;
    gap: 0.25rem;
    align-content: start;
  }

  .search-field {
    grid-column: 1 / -1;
  }

  .list-field {
    grid-column: span 2;
  }

  label {
    font-size: 0.79rem;
    color: #486581;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  input,
  select {
    width: 100%;
    border: 1px solid #c5d0da;
    border-radius: 0.45rem;
    background: #fff;
    color: #102a43;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.36rem 0.45rem;
    min-height: 2rem;
  }

  input:disabled,
  select:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .search-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
  }

  .search-button {
    border: 1px solid #6f9fdd;
    border-radius: 0.45rem;
    background: #e8f2ff;
    color: #0b4ea2;
    font-weight: 700;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.44rem 0.75rem;
    cursor: pointer;
    min-height: 2rem;
  }

  .search-button:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .actions {
    display: flex;
    align-items: end;
    align-self: end;
  }

  .clear-button {
    border: 1px solid #cfd8e3;
    border-radius: 0.45rem;
    background: #f5f7fa;
    color: #334e68;
    font-weight: 650;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.44rem 0.6rem;
    cursor: pointer;
    min-height: 2rem;
  }

  .clear-button.modified {
    border-color: #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .clear-button:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .field-note {
    margin: 0;
    font-size: 0.78rem;
    color: #486581;
  }

  .field-error {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .field-error p {
    margin: 0;
    font-size: 0.78rem;
    color: #8a1c1c;
  }

  .field-error button {
    border: 1px solid #e7b4b8;
    border-radius: 0.42rem;
    background: #fff;
    color: #8a1c1c;
    font-size: 0.76rem;
    font-weight: 700;
    line-height: 1;
    padding: 0.3rem 0.45rem;
    cursor: pointer;
  }

  .field-error button:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  @media (max-width: 760px) {
    .search-form {
      grid-template-columns: 1fr;
    }

    .list-field {
      grid-column: span 1;
    }

    .actions {
      grid-column: span 1;
      align-items: start;
      align-self: start;
    }
  }
</style>
