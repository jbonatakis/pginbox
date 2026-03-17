<script lang="ts">
  import { navigate, threadsPath } from "../router";

  let searchQuery = "";
  const suggestedQueries = [
    "AIO",
    "walsender",
    "repack",
  ];

  const threadsSearchPath = (query: string): string => {
    const normalized = query.trim();
    if (normalized.length === 0) return threadsPath;

    const params = new URLSearchParams({ q: normalized });
    return `${threadsPath}?${params.toString()}`;
  };

  const submitSearch = (): void => {
    navigate(threadsSearchPath(searchQuery));
  };

  const applySuggestedQuery = (query: string): void => {
    searchQuery = query;
    submitSearch();
  };
</script>

<section class="home-page">
  <div class="search-stage">
    <h1 class="page-title" data-route-heading tabindex="-1">Search the PostgreSQL mailing lists</h1>

    <form
      class="search-shell"
      role="search"
      on:submit|preventDefault={submitSearch}
    >
      <div class="search-frame">
        <input
          id="home-search"
          type="search"
          name="q"
          bind:value={searchQuery}
          aria-label="Search threads"
          placeholder="Search thread subjects"
        />
        <button type="submit" class="search-button">Search</button>
      </div>
    </form>

    <div class="search-suggestions" aria-label="Suggested searches">
      {#each suggestedQueries as query}
        <button type="button" class="suggestion-chip" on:click={() => applySuggestedQuery(query)}
          >{query}</button
        >
      {/each}
    </div>
  </div>
</section>

<style>
  .home-page {
    min-height: calc(100vh - 12rem);
    display: grid;
    align-content: start;
    justify-items: center;
    gap: 1.1rem;
    padding: clamp(2.4rem, 7vh, 5rem) 0 2rem;
  }

  .search-stage {
    width: min(100%, 56rem);
    position: relative;
    isolation: isolate;
    display: grid;
    gap: 0.95rem;
    justify-items: center;
    text-align: center;
    padding: clamp(0.35rem, 1.4vw, 0.75rem);
    border-radius: 1rem;
  }

  .search-stage::before {
    content: "";
    position: absolute;
    z-index: -1;
    inset: -0.6rem -1.25rem -1rem;
    border-radius: 2rem;
    background:
      radial-gradient(
        70% 46% at 50% 30%,
        rgba(11, 78, 162, 0.08) 0%,
        rgba(11, 78, 162, 0.03) 46%,
        rgba(11, 78, 162, 0) 100%
      ),
      radial-gradient(
        92% 72% at 50% 92%,
        rgba(16, 42, 67, 0.2) 0%,
        rgba(16, 42, 67, 0.08) 42%,
        rgba(16, 42, 67, 0) 100%
      );
    filter: blur(14px);
    opacity: 0.76;
    pointer-events: none;
  }

  .page-title {
    margin: 0;
    max-width: 13ch;
    color: var(--text);
    font-size: clamp(2.25rem, 6vw, 4.1rem);
    line-height: 1.02;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }

  .search-shell {
    width: 100%;
  }

  .search-frame {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    padding: 0.52rem 0.56rem 0.52rem 1rem;
    border: 1px solid rgba(126, 151, 177, 0.5);
    border-radius: 0.95rem;
    background: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 20px 38px -34px rgba(16, 42, 67, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.88);
  }

  input {
    width: 100%;
    border: 0;
    padding: 0.6rem 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    color: var(--text);
    font-size: clamp(1rem, 2.2vw, 1.15rem);
    line-height: 1.2;
  }

  input::-webkit-search-decoration,
  input::-webkit-search-cancel-button,
  input::-webkit-search-results-button,
  input::-webkit-search-results-decoration {
    -webkit-appearance: none;
  }

  input::placeholder {
    color: #708299;
  }

  input:focus,
  input:focus-visible {
    outline: none;
    box-shadow: none;
  }

  .search-frame:focus-within {
    border-color: var(--primary);
    box-shadow:
      0 0 0 3px rgba(11, 78, 162, 0.15),
      0 20px 38px -34px rgba(16, 42, 67, 0.4);
  }

  .search-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.38rem;
    padding: 0.45rem 0.95rem;
    border: 1px solid var(--primary);
    border-radius: 0.72rem;
    background: var(--primary);
    color: #fff;
    font-size: 0.83rem;
    font-weight: 700;
    letter-spacing: 0.015em;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      transform 120ms ease;
  }

  .search-button:hover {
    background: var(--primary-hover);
    transform: translateY(-1px);
  }

  .search-suggestions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }

  .suggestion-chip {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.82);
    color: #304a64;
    padding: 0.33rem 0.68rem;
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .suggestion-chip:hover {
    border-color: rgba(111, 159, 221, 0.76);
    background: var(--primary-soft);
    color: var(--primary);
  }

  @media (max-width: 640px) {
    .home-page {
      min-height: auto;
      align-content: start;
      padding-top: 0.35rem;
    }

    .search-stage {
      gap: 0.8rem;
      padding: 0.3rem;
    }

    .search-stage::before {
      inset: -0.35rem -0.45rem -0.55rem;
      border-radius: 1.25rem;
      filter: blur(10px);
      opacity: 0.68;
    }

    .page-title {
      max-width: none;
      font-size: clamp(2.1rem, 11vw, 3rem);
    }

    .search-frame {
      gap: 0.5rem;
      padding: 0.48rem 0.48rem 0.48rem 0.82rem;
    }

    .search-button {
      min-height: 2.1rem;
      padding: 0.4rem 0.72rem;
      font-size: 0.77rem;
    }

    .search-suggestions {
      gap: 0.45rem;
    }

    .suggestion-chip {
      font-size: 0.73rem;
      padding: 0.3rem 0.62rem;
    }
  }
</style>
