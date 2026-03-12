<script lang="ts">
  import { analyticsPath, navigate, onLinkClick, peoplePath, threadsPath } from "../router";

  type Shortcut = {
    description: string;
    href: string;
    label: string;
  };

  const shortcuts: Shortcut[] = [
    {
      href: threadsPath,
      label: "Threads",
      description: "Browse discussions by subject, date, and timeline.",
    },
    {
      href: peoplePath,
      label: "People",
      description: "Start from contributors instead of conversations.",
    },
    {
      href: analyticsPath,
      label: "Analytics",
      description: "See archive-wide counts and activity patterns.",
    },
  ];

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
    <p class="lede">
      Start with a subject search, then drop into the thread explorer to refine by list and date.
    </p>

    <form
      class="search-shell"
      role="search"
      aria-labelledby="home-search-label"
      aria-describedby="home-search-note"
      on:submit|preventDefault={submitSearch}
    >
      <label id="home-search-label" class="sr-only" for="home-search">Search the archive</label>
      <div class="search-frame">
        <input
          id="home-search"
          type="search"
          name="q"
          bind:value={searchQuery}
          placeholder="Search thread subjects"
        />
        <button type="submit" class="search-button">Search</button>
      </div>
    </form>

    <p id="home-search-note" class="search-note">
      MVP search looks at thread subjects only. Results open in the threads view.
    </p>

    <div class="shortcut-grid" aria-label="Available archive views">
      {#each shortcuts as shortcut}
        <a
          class="shortcut-card"
          href={shortcut.href}
          on:click={(event) => onLinkClick(event, shortcut.href)}
        >
          <strong>{shortcut.label}</strong>
          <span>{shortcut.description}</span>
        </a>
      {/each}
    </div>
  </div>

  <p class="future-note">
    Later this page can add hot threads or recent discussions under the search box.
  </p>
</section>

<style>
  .home-page {
    min-height: calc(100vh - 11rem);
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 1rem;
    padding: 1.2rem 0 2rem;
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
    line-height: 0.95;
    letter-spacing: -0.05em;
  }

  .lede,
  .search-note,
  .future-note,
  .shortcut-card span {
    margin: 0;
    color: #486581;
    line-height: 1.5;
  }

  .lede {
    max-width: 40rem;
    font-size: 1.02rem;
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
    color: #102a43;
    font-size: clamp(1rem, 2.2vw, 1.15rem);
    line-height: 1.2;
  }

  input::placeholder {
    color: #7b8794;
  }

  input:focus {
    outline: none;
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

  .search-note {
    max-width: 36rem;
    font-size: 0.95rem;
  }

  .shortcut-grid {
    width: 100%;
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  }

  .shortcut-card {
    padding: 0.95rem 1rem;
    border: 1px solid rgba(151, 169, 190, 0.42);
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.88);
    text-decoration: none;
    display: grid;
    gap: 0.35rem;
    text-align: left;
    transition:
      transform 140ms ease,
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .shortcut-card strong {
    color: #102a43;
    font-size: 1rem;
  }

  .shortcut-card:hover {
    transform: translateY(-1px);
    border-color: #93b3da;
    box-shadow: 0 16px 30px -26px rgba(16, 42, 67, 0.42);
  }

  .future-note {
    width: min(100%, 42rem);
    text-align: center;
    font-size: 0.92rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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
      grid-template-columns: 1fr;
      justify-items: start;
      border-radius: 1.2rem;
      padding: 0.8rem 0.9rem;
    }

    .search-button {
      min-height: 2rem;
    }
  }
</style>
