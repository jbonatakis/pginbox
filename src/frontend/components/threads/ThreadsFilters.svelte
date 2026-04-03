<script lang="ts">
  import { DEFAULT_THREAD_SEARCH_SCOPE, type List, type ThreadSearchScope } from "shared/api";
  import { createEventDispatcher, onMount } from "svelte";
  import { THREADS_QUERY_DEFAULT_LIMIT } from "../../lib/state/threadsQuery";

  const DATE_TEXT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DATE_SEPARATOR_PATTERN = /[\u2010-\u2015\u2212/.\s]+/g;
  const NON_DIGIT_PATTERN = /\D+/g;

  export let fromDate = "";
  export let defaultLimit = THREADS_QUERY_DEFAULT_LIMIT;
  export let isBusy = false;
  export let isListsLoading = false;
  export let limit = 25;
  export let limitOptions: number[] = [10, 25, 50, 100];
  export let listOptions: List[] = [];
  export let listsErrorMessage: string | null = null;
  export let searchQuery = "";
  export let searchIn: ThreadSearchScope = DEFAULT_THREAD_SEARCH_SCOPE;
  export let selectedList: string | undefined;
  export let toDate = "";

  const dispatch = createEventDispatcher<{
    retrylists: void;
    searchsubmit: {
      from: string | null;
      limit: number;
      list: string | null;
      q: string | null;
      searchIn: ThreadSearchScope;
      to: string | null;
    };
  }>();

  const SEARCH_SCOPE_OPTIONS: Array<{ description: string; label: string; value: ThreadSearchScope }> = [
    {
      value: "subject",
      label: "Subject",
      description: "Search subjects only",
    },
    {
      value: "body",
      label: "Message body",
      description: "Search message contents only",
    },
  ];

  let searchDraft = searchQuery;
  let searchInDraft = searchIn;
  let selectedListDraft = selectedList ?? "";
  let fromDateDraft = fromDate;
  let toDateDraft = toDate;
  let limitDraft = limit;
  let isExpanded = false;
  let useCompactDateInputs = false;
  let lastSyncedFilterState = "";
  let fromInputElement: HTMLInputElement | null = null;
  let toInputElement: HTMLInputElement | null = null;
  let fromDateBadInput = false;
  let toDateBadInput = false;

  const normalizedDraftText = (value: string): string | null => {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  };

  const formatDateDigits = (value: string): string => {
    const digits = value.replace(NON_DIGIT_PATTERN, "").slice(0, 8);
    if (digits.length <= 4) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  };

  const normalizeDateDraftInput = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed === "") return "";

    const hasLetters = /[a-z]/i.test(trimmed);
    if (!hasLetters) {
      const digits = trimmed.replace(NON_DIGIT_PATTERN, "");
      if (digits.length > 0) {
        return formatDateDigits(digits);
      }
    }

    return trimmed.replace(DATE_SEPARATOR_PATTERN, "-");
  };

  const isValidDateDraft = (value: string): boolean => {
    const normalized = normalizeDateDraftInput(value);
    const match = DATE_TEXT_PATTERN.exec(normalized);
    if (!match) return false;

    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  };

  const syncDateInputValidity = (): void => {
    const fromDraft = normalizeDateDraftInput(fromDateDraft);
    const toDraft = normalizeDateDraftInput(toDateDraft);
    const invalidDateMessage = "Use YYYY-MM-DD";

    if (fromInputElement) {
      const isInvalidFrom = useCompactDateInputs && fromDraft !== "" && !isValidDateDraft(fromDraft);
      fromInputElement.setCustomValidity(isInvalidFrom ? invalidDateMessage : "");
    }

    if (toInputElement) {
      const isInvalidTo = useCompactDateInputs && toDraft !== "" && !isValidDateDraft(toDraft);
      toInputElement.setCustomValidity(isInvalidTo ? invalidDateMessage : "");
    }

    const hasValidRange =
      fromDraft !== "" &&
      toDraft !== "" &&
      isValidDateDraft(fromDraft) &&
      isValidDateDraft(toDraft);

    if (hasValidRange && fromDraft > toDraft) {
      const rangeMessage = "From date must be on or before To date";
      fromInputElement?.setCustomValidity(rangeMessage);
      toInputElement?.setCustomValidity(rangeMessage);
    }
  };

  const serializeFilterState = (): string =>
    JSON.stringify({
      fromDate,
      limit,
      searchQuery,
      searchIn,
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
      fromDateBadInput = false;
      limitDraft = limit;
      searchDraft = searchQuery;
      searchInDraft = searchIn;
      selectedListDraft = selectedList ?? "";
      toDateDraft = toDate;
      toDateBadInput = false;
    }
  }

  $: hasInvalidDateDraft =
    fromDateBadInput ||
    toDateBadInput ||
    (useCompactDateInputs && fromDateDraft !== "" && !isValidDateDraft(normalizeDateDraftInput(fromDateDraft))) ||
    (useCompactDateInputs && toDateDraft !== "" && !isValidDateDraft(normalizeDateDraftInput(toDateDraft)));
  $: hasUnknownSelectedList =
    selectedListDraft.length > 0 &&
    !listOptions.some((candidate) => candidate.name === selectedListDraft);
  $: modifiedFilterCount =
    Number(searchDraft !== "") +
    Number(selectedListDraft !== "") +
    Number(fromDateDraft !== "") +
    Number(toDateDraft !== "") +
    Number(Number(limitDraft) !== defaultLimit);
  $: hasModifiedFilters =
    modifiedFilterCount > 0;
  $: filtersSummary =
    modifiedFilterCount > 0
      ? `${modifiedFilterCount} filter${modifiedFilterCount === 1 ? "" : "s"} selected`
      : "All threads view";

  const emitClear = (): void => {
    fromDateDraft = "";
    fromDateBadInput = false;
    if (fromInputElement) fromInputElement.value = "";
    limitDraft = defaultLimit;
    searchDraft = "";
    selectedListDraft = "";
    toDateDraft = "";
    toDateBadInput = false;
    if (toInputElement) toInputElement.value = "";
    dispatch("searchsubmit", {
      from: null,
      limit: defaultLimit,
      list: null,
      q: null,
      searchIn: searchInDraft,
      to: null,
    });
  };

  const emitRetryLists = (): void => {
    dispatch("retrylists");
  };

  const toggleExpanded = (): void => {
    isExpanded = !isExpanded;
  };

  const setSearchInDraft = (value: ThreadSearchScope): void => {
    searchInDraft = value;
  };

  const normalizeFromDateDraft = (event?: Event): void => {
    if (!useCompactDateInputs && event?.currentTarget instanceof HTMLInputElement) {
      fromDateBadInput = event.currentTarget.validity.badInput;
    }
    fromDateDraft = normalizeDateDraftInput(fromDateDraft);
  };

  const normalizeToDateDraft = (event?: Event): void => {
    if (!useCompactDateInputs && event?.currentTarget instanceof HTMLInputElement) {
      toDateBadInput = event.currentTarget.validity.badInput;
    }
    toDateDraft = normalizeDateDraftInput(toDateDraft);
  };

  const handleFromDateInput = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement) || !useCompactDateInputs) return;
    fromDateDraft = normalizeDateDraftInput(target.value);
  };

  const handleToDateInput = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement) || !useCompactDateInputs) return;
    toDateDraft = normalizeDateDraftInput(target.value);
  };

  const reopenPickerIfBadInput = (target: HTMLInputElement): void => {
    if (!target.validity.badInput) return;
    try {
      target.showPicker();
    } catch {
      target.value = "";
    }
  };

  const handleFromDateChange = (event: Event): void => {
    if (useCompactDateInputs) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    fromDateBadInput = target.validity.badInput;
    reopenPickerIfBadInput(target);
  };

  const handleToDateChange = (event: Event): void => {
    if (useCompactDateInputs) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    toDateBadInput = target.validity.badInput;
    reopenPickerIfBadInput(target);
  };

  const emitSearchSubmit = (): void => {
    normalizeFromDateDraft();
    normalizeToDateDraft();
    syncDateInputValidity();

    const invalidInput = [fromInputElement, toInputElement].find(
      (input) => input !== null && !input.checkValidity()
    );
    if (invalidInput) {
      invalidInput.reportValidity();
      invalidInput.focus();
      return;
    }

    const parsedLimit = Number(limitDraft);

    dispatch("searchsubmit", {
      from: normalizedDraftText(normalizeDateDraftInput(fromDateDraft)),
      limit: Number.isInteger(parsedLimit) ? parsedLimit : limit,
      list: normalizedDraftText(selectedListDraft),
      q: normalizedDraftText(searchDraft),
      searchIn: searchInDraft,
      to: normalizedDraftText(normalizeDateDraftInput(toDateDraft)),
    });
  };

  $: syncDateInputValidity();

  onMount(() => {
    if (typeof window === "undefined") return undefined;

    const mediaQuery = window.matchMedia("(max-width: 760px)");
    const updateCompactDateMode = (): void => {
      useCompactDateInputs = mediaQuery.matches;
    };

    updateCompactDateMode();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateCompactDateMode);
      return () => {
        mediaQuery.removeEventListener("change", updateCompactDateMode);
      };
    }

    mediaQuery.addListener(updateCompactDateMode);
    return () => {
      mediaQuery.removeListener(updateCompactDateMode);
    };
  });
</script>

<section class="filters-card" aria-label="Thread filters">
  <div class="filters-header">
    <div class="filters-summary">
      <h2>Filters</h2>
      <p>{filtersSummary}</p>
    </div>

    <button
      type="button"
      class="filters-toggle"
      class:modified={hasModifiedFilters}
      aria-controls="threads-filter-fields"
      aria-expanded={isExpanded}
      on:click={toggleExpanded}
    >
      {isExpanded ? "Hide filters" : "Show filters"}
    </button>
  </div>

  <form
    id="threads-filter-fields"
    class="filters"
    hidden={!isExpanded}
    on:submit|preventDefault={emitSearchSubmit}
  >
    <div class="field search-field">
      <label for="threads-search">Search threads</label>
      <div class="search-scope" role="group" aria-label="Search scope">
        {#each SEARCH_SCOPE_OPTIONS as option}
          <button
            type="button"
            class="scope-button"
            class:active={searchInDraft === option.value}
            aria-pressed={searchInDraft === option.value}
            disabled={isBusy}
            on:click={() => setSearchInDraft(option.value)}
          >
            <span>{option.label}</span>
            <small>{option.description}</small>
          </button>
        {/each}
      </div>
      <div class="search-form">
        <input
          id="threads-search"
          type="search"
          bind:value={searchDraft}
          placeholder={searchInDraft === "body" ? "Search message bodies" : "Search thread subjects"}
          disabled={isBusy}
        />
        <button type="submit" class="search-button" disabled={isBusy || hasInvalidDateDraft}>Search</button>
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
        type={useCompactDateInputs ? "text" : "date"}
        inputmode={useCompactDateInputs ? "numeric" : undefined}
        placeholder={useCompactDateInputs ? "YYYY-MM-DD" : undefined}
        maxlength={useCompactDateInputs ? 10 : undefined}
        bind:value={fromDateDraft}
        max={!useCompactDateInputs ? toDateDraft || undefined : undefined}
        disabled={isBusy}
        bind:this={fromInputElement}
        on:input={handleFromDateInput}
        on:change={handleFromDateChange}
        on:blur={normalizeFromDateDraft}
      />
    </div>

    <div class="field">
      <label for="threads-to">To</label>
      <input
        id="threads-to"
        type={useCompactDateInputs ? "text" : "date"}
        inputmode={useCompactDateInputs ? "numeric" : undefined}
        placeholder={useCompactDateInputs ? "YYYY-MM-DD" : undefined}
        maxlength={useCompactDateInputs ? 10 : undefined}
        bind:value={toDateDraft}
        min={!useCompactDateInputs ? fromDateDraft || undefined : undefined}
        disabled={isBusy}
        bind:this={toInputElement}
        on:input={handleToDateInput}
        on:change={handleToDateChange}
        on:blur={normalizeToDateDraft}
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
</section>

<style>
  .filters-card {
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-soft);
    padding: 0.7rem;
    display: grid;
    gap: 0.65rem;
  }

  .filters-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
  }

  .filters-summary {
    min-width: 0;
    display: grid;
    gap: 0.12rem;
  }

  .filters-summary h2 {
    margin: 0;
    color: var(--text);
    font-size: 0.92rem;
    line-height: 1.1;
  }

  .filters-summary p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1.2;
  }

  .filters-toggle {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: #f5f7fa;
    color: var(--text-subtle);
    font-weight: 700;
    font-size: 0.8rem;
    line-height: 1;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .filters-toggle.modified {
    border-color: rgba(111, 159, 221, 0.76);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.65rem;
    align-items: start;
  }

  .filters[hidden] {
    display: none;
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
    color: var(--text-muted);
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: #fff;
    color: var(--text);
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

  input:invalid {
    border-color: var(--error, #c0392b);
  }

  input[type="date"] {
    box-sizing: border-box;
    display: block;
    inline-size: 100%;
    min-inline-size: 0;
    max-width: 100%;
    min-width: 0;
  }

  input[type="date"]::-webkit-date-and-time-value {
    text-align: left;
  }

  .search-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
  }

  .search-scope {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.45rem;
  }

  .scope-button {
    border: 1px solid var(--border);
    border-radius: 0.55rem;
    background: #fff;
    color: var(--text);
    display: grid;
    gap: 0.08rem;
    justify-items: start;
    padding: 0.5rem 0.6rem;
    text-align: left;
    cursor: pointer;
  }

  .scope-button span {
    font-size: 0.84rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .scope-button small {
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.2;
  }

  .scope-button.active {
    border-color: rgba(111, 159, 221, 0.76);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .scope-button.active small {
    color: var(--primary);
  }

  .scope-button:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .search-button {
    border: 1px solid rgba(111, 159, 221, 0.76);
    border-radius: 0.45rem;
    background: var(--primary-soft);
    color: var(--primary);
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
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: #f5f7fa;
    color: var(--text-subtle);
    font-weight: 650;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.44rem 0.6rem;
    cursor: pointer;
    min-height: 2rem;
  }

  .clear-button.modified {
    border-color: rgba(111, 159, 221, 0.76);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .clear-button:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .field-note {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
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
    color: var(--danger);
  }

  .field-error button {
    border: 1px solid var(--danger-border);
    border-radius: 0.42rem;
    background: #fff;
    color: var(--danger);
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
    .filters-card {
      padding: 0.65rem;
    }

    .filters-header {
      align-items: start;
    }

    .filters-toggle {
      flex-shrink: 0;
    }

    .filters {
      grid-template-columns: 1fr;
    }

    input[type="date"] {
      width: 100%;
      font-size: 0.8rem;
      padding-right: 0.3rem;
    }

    input[type="date"]::-webkit-datetime-edit {
      padding: 0;
    }

    input[type="date"]::-webkit-datetime-edit-fields-wrapper {
      padding: 0;
    }

    input[type="date"]::-webkit-calendar-picker-indicator {
      margin: 0;
      padding: 0;
    }

    .search-form {
      grid-template-columns: 1fr;
    }

    .search-scope {
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
