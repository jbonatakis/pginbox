<script lang="ts">
  import type { PersonListItem } from "shared/api";
  import { onLinkClick, personDetailPath } from "../../router";

  export let items: PersonListItem[] = [];
  export let rankOffset = 0;

  const messageCountFormatter = new Intl.NumberFormat("en-US");

  const messageLabel = (count: number): string =>
    count === 1 ? "1 message" : `${messageCountFormatter.format(count)} messages`;

  const personPath = (id: number): string => personDetailPath(String(id));
</script>

<ol class="people-list" start={rankOffset + 1}>
  {#each items as person, index (person.id)}
    {@const path = personPath(person.id)}
    <li>
      <a class="row" href={path} on:click={(event) => onLinkClick(event, path)}>
        <span class="rank">{rankOffset + index + 1}</span>
        <span class="name">{person.name}</span>
        <span class="count">{messageLabel(person.message_count)}</span>
      </a>
    </li>
  {/each}
</ol>

<style>
  .people-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.5rem;
  }

  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface-soft);
    padding: 0.56rem 0.72rem;
    text-decoration: none;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease;
  }

  .row:hover {
    border-color: #9fb3c8;
    background: var(--primary-soft);
    box-shadow: 0 0 0 2px rgba(159, 179, 200, 0.18);
  }

  .row:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .rank {
    min-width: 1.6rem;
    font-size: 0.84rem;
    font-weight: 700;
    color: var(--text-muted);
    text-align: right;
  }

  .name {
    min-width: 0;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .count {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--primary);
    white-space: nowrap;
  }

  @media (max-width: 560px) {
    .row {
      grid-template-columns: auto minmax(0, 1fr);
      row-gap: 0.2rem;
    }

    .count {
      grid-column: 2;
      white-space: normal;
    }
  }
</style>
