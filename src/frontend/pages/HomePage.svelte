<script lang="ts">
  import { navigate, threadsPath } from "../router";

  let searchQuery = "";

  const threadsSearchPath = (query: string): string => {
    const normalized = query.trim();
    if (normalized.length === 0) return threadsPath;

    const params = new URLSearchParams({ q: normalized });
    return `${threadsPath}?${params.toString()}`;
  };

  const submitSearch = (): void => {
    navigate(threadsSearchPath(searchQuery));
  };
</script>

<section class="home-page">
  <div class="search-stage">
    <h1 class="page-title" data-route-heading tabindex="-1">Search PostgreSQL mailing list history</h1>

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
          placeholder="Search threads"
        />
        <button type="submit" class="search-button">Search</button>
      </div>
    </form>
  </div>
</section>

<style>
  .home-page {
    min-height: calc(100vh - 11rem);
    display: grid;
    align-content: start;
    justify-items: center;
    gap: 1rem;
    padding: clamp(2.5rem, 8vh, 5.5rem) 0 2rem;
  }

  .search-stage {
    width: min(100%, 54rem);
    display: grid;
    gap: 1rem;
    justify-items: center;
    text-align: center;
  }

  .page-title {
    margin: 0;
    max-width: 12ch;
    color: #102a43;
    font-size: clamp(2.4rem, 7vw, 4.8rem);
    line-height: 1.02;
    letter-spacing: -0.05em;
  }

  .search-shell {
    width: 100%;
  }

  .search-frame {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0.65rem 0.55rem 1.1rem;
    border: 1px solid rgba(146, 166, 188, 0.45);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.94);
    box-shadow:
      0 22px 45px -30px rgba(16, 42, 67, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.88);
  }

  input {
    width: 100%;
    border: 0;
    padding: 0.6rem 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    color: #102a43;
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
    color: #7b8794;
  }

  input:focus,
  input:focus-visible {
    outline: none;
    box-shadow: none;
  }

  .search-frame:focus-within {
    border-color: #6f9fdd;
    box-shadow:
      0 0 0 3px rgba(11, 78, 162, 0.16),
      0 22px 45px -30px rgba(16, 42, 67, 0.4);
  }

  .search-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.4rem;
    padding: 0.45rem 0.85rem;
    border: 1px solid #6f9fdd;
    border-radius: 999px;
    background: #e8f2ff;
    color: #0b4ea2;
    font-size: 0.84rem;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
  }

  .search-button:hover {
    background: #dcebff;
  }

  @media (max-width: 640px) {
    .home-page {
      min-height: auto;
      align-content: start;
      padding-top: 0.5rem;
    }

    .search-stage {
      gap: 0.85rem;
    }

    .page-title {
      max-width: none;
      font-size: clamp(2.2rem, 12vw, 3.2rem);
    }

    .search-frame {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.55rem;
      padding: 0.5rem 0.55rem 0.5rem 0.9rem;
    }

    .search-button {
      min-height: 2.15rem;
      padding: 0.4rem 0.72rem;
      font-size: 0.8rem;
    }
  }
</style>
