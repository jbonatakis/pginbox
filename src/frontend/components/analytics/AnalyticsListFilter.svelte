<script lang="ts">
  import type { List } from "shared/api";
  import { createEventDispatcher, onDestroy } from "svelte";

  export let lists: List[] = [];
  export let selectedIds: number[] = [];
  export let disabled = false;

  const dispatch = createEventDispatcher<{ change: number[] }>();

  let isOpen = false;
  let triggerEl: HTMLButtonElement | null = null;
  let panelEl: HTMLDivElement | null = null;

  $: label = selectedIds.length === 0
    ? "All lists"
    : selectedIds.length === 1
      ? (lists.find((l) => l.id === selectedIds[0])?.name ?? "1 list")
      : `${selectedIds.length} lists`;

  $: isFiltered = selectedIds.length > 0;

  function toggle(listId: number): void {
    const next = selectedIds.includes(listId)
      ? selectedIds.filter((id) => id !== listId)
      : [...selectedIds, listId];
    dispatch("change", next);
  }

  function clear(): void {
    dispatch("change", []);
    isOpen = false;
  }

  function handleTriggerClick(): void {
    isOpen = !isOpen;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      isOpen = false;
      triggerEl?.focus();
    }
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!isOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (triggerEl?.contains(target) || panelEl?.contains(target)) return;
    isOpen = false;
  }

  onDestroy(() => {
    isOpen = false;
  });
</script>

<svelte:window on:click={handleWindowClick} on:keydown={handleKeydown} />

<div class="filter-wrap">
  <button
    bind:this={triggerEl}
    type="button"
    class="trigger"
    class:active={isFiltered}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    {disabled}
    on:click={handleTriggerClick}
  >
    <span class="trigger-label">{label}</span>
    <svg class="chevron" class:open={isOpen} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  {#if isOpen && lists.length > 0}
    <div bind:this={panelEl} class="panel" role="listbox" aria-multiselectable="true" aria-label="Filter by list">
      {#each lists as list (list.id)}
        {@const checked = selectedIds.includes(list.id)}
        <label class="option" class:checked>
          <input
            type="checkbox"
            {checked}
            on:change={() => toggle(list.id)}
          />
          <span class="option-name">{list.name}</span>
          {#if checked}
            <svg class="check-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {/if}
        </label>
      {/each}
      {#if isFiltered}
        <div class="panel-footer">
          <button type="button" class="clear-btn" on:click={clear}>Clear filter</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .filter-wrap {
    position: relative;
    display: inline-block;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: #f5f7fa;
    color: var(--text-subtle);
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1;
    padding: 0.42rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }

  .trigger.active {
    border-color: rgba(111, 159, 221, 0.76);
    background: var(--primary-soft);
    color: var(--primary);
  }

  .trigger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .trigger-label {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .panel {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 100;
    min-width: 12rem;
    max-width: 22rem;
    max-height: 18rem;
    overflow-y: auto;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    padding: 0.3rem 0;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.42rem 0.75rem;
    cursor: pointer;
    font-size: 0.84rem;
    color: var(--text);
    font-weight: 500;
    user-select: none;
  }

  .option:hover {
    background: var(--surface-soft);
  }

  .option.checked {
    color: var(--primary);
    background: var(--primary-soft);
  }

  .option input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0;
    height: 0;
  }

  .option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-icon {
    flex-shrink: 0;
    color: var(--primary);
  }

  .panel-footer {
    border-top: 1px solid var(--border);
    margin-top: 0.3rem;
    padding: 0.3rem 0.6rem;
  }

  .clear-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.79rem;
    font-weight: 650;
    cursor: pointer;
    padding: 0.25rem 0.15rem;
  }

  .clear-btn:hover {
    color: var(--text);
  }
</style>
