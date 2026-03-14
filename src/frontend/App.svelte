<script lang="ts">
  import { tick } from "svelte";
  import AnalyticsPage from "./pages/AnalyticsPage.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import NotFoundPage from "./pages/NotFoundPage.svelte";
  import PeoplePage from "./pages/PeoplePage.svelte";
  import PersonDetailPage from "./pages/PersonDetailPage.svelte";
  import ThreadDetailPage from "./pages/ThreadDetailPage.svelte";
  import ThreadsPage from "./pages/ThreadsPage.svelte";
  import {
    analyticsPath,
    currentRoute,
    homePath,
    onLinkClick,
    peoplePath,
    threadsPath,
    type AppRoute,
  } from "./router";

  type ContextChip = {
    label: string;
    value: string;
  };

  const navItems: Array<{
    label: string;
    path: string;
    activeWhen: AppRoute["name"][];
  }> = [
    { label: "Home", path: homePath, activeWhen: ["home"] },
    { label: "Threads", path: threadsPath, activeWhen: ["threads", "thread-detail"] },
    { label: "People", path: peoplePath, activeWhen: ["people", "person-detail"] },
    { label: "Analytics", path: analyticsPath, activeWhen: ["analytics"] },
  ];

  const isActiveNavItem = (item: (typeof navItems)[number], routeName: AppRoute["name"]): boolean =>
    item.activeWhen.includes(routeName);

  const clipped = (value: string, maxLength: number): string =>
    value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

  const contextChipsForRoute = (route: AppRoute): ContextChip[] => {
    if (route.name === "threads") {
      return [];
    }

    if (route.name === "thread-detail") {
      return [
        { label: "View", value: "Thread detail" },
        { label: "Thread", value: clipped(route.params.threadId, 40) },
        { label: "Session", value: "Timeline mode" },
      ];
    }

    if (route.name === "people") {
      return [];
    }

    if (route.name === "person-detail") {
      return [
        { label: "View", value: "Person detail" },
        { label: "Contributor", value: clipped(route.params.id, 30) },
        { label: "Session", value: "Profile mode" },
      ];
    }

    if (route.name === "analytics") {
      return [];
    }

    return [
      { label: "View", value: "Unknown route" },
      { label: "Path", value: clipped(route.pathname, 40) },
      { label: "Session", value: "Recoverable state" },
    ];
  };

  let contentElement: HTMLElement | null = null;
  let handledRoutePathname: string | null =
    typeof window !== "undefined" ? window.location.pathname : null;
  let routeContextChips: ContextChip[] = [];

  const documentTitleForRoute = (route: AppRoute): string => {
    if (route.name === "home") return "pginbox | PostgreSQL mailing list archive";
    if (route.name === "threads") return "Threads | pginbox";
    if (route.name === "thread-detail") return `Thread ${clipped(route.params.threadId, 48)} | pginbox`;
    if (route.name === "people") return "People | pginbox";
    if (route.name === "person-detail") return `Person ${clipped(route.params.id, 40)} | pginbox`;
    if (route.name === "analytics") return "Analytics | pginbox";
    return "Not Found | pginbox";
  };

  const focusRouteHeading = async (): Promise<void> => {
    await tick();

    const heading = contentElement?.querySelector<HTMLElement>("[data-route-heading]");
    if (heading) {
      heading.focus();
      return;
    }

    contentElement?.focus();
  };

  $: if (typeof document !== "undefined") {
    const route = $currentRoute;
    document.title = documentTitleForRoute(route);

    if (route.pathname !== handledRoutePathname) {
      handledRoutePathname = route.pathname;
      void focusRouteHeading();
    }
  }

  $: routeContextChips = contextChipsForRoute($currentRoute);
</script>

<div class="shell">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <header class="shell-header">
    <div class="brand-block">
      <a href={homePath} class="brand-link" on:click={(event) => onLinkClick(event, homePath)}
        >pginbox</a
      >
      <p>Searchable PostgreSQL mailing list history</p>
    </div>

    <nav aria-label="Primary navigation">
      {#each navItems as item}
        <a
          href={item.path}
          class:active={isActiveNavItem(item, $currentRoute.name)}
          aria-current={isActiveNavItem(item, $currentRoute.name) ? "page" : undefined}
          on:click={(event) => onLinkClick(event, item.path)}>{item.label}</a
        >
      {/each}
    </nav>
  </header>

  {#if $currentRoute.name !== "home" && routeContextChips.length > 0}
    <section class="context-strip" aria-label="Current context">
      {#each routeContextChips as chip}
        <p class="context-chip">
          <span>{chip.label}</span>
          <strong>{chip.value}</strong>
        </p>
      {/each}
    </section>
  {/if}

  <main id="main-content" class="content" tabindex="-1" bind:this={contentElement}>
    {#if $currentRoute.name === "home"}
      <HomePage />
    {:else if $currentRoute.name === "threads"}
      <ThreadsPage />
    {:else if $currentRoute.name === "thread-detail"}
      <ThreadDetailPage threadId={$currentRoute.params.threadId} />
    {:else if $currentRoute.name === "people"}
      <PeoplePage />
    {:else if $currentRoute.name === "person-detail"}
      <PersonDetailPage id={$currentRoute.params.id} />
    {:else if $currentRoute.name === "analytics"}
      <AnalyticsPage />
    {:else}
      <NotFoundPage pathname={$currentRoute.pathname} />
    {/if}
  </main>
</div>

<style>
  :global(:root) {
    --focus-ring-color: #0b4ea2;
    --focus-ring-shadow: rgba(11, 78, 162, 0.18);
  }

  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body) {
    max-width: 100%;
  }

  :global(body) {
    margin: 0;
    font-family:
      "IBM Plex Sans",
      "Segoe UI",
      sans-serif;
    line-height: 1.45;
    color: #102a43;
    background:
      radial-gradient(circle at 8% 0%, #e3eefc 0%, rgba(227, 238, 252, 0) 35%),
      radial-gradient(circle at 95% 5%, #f8f2df 0%, rgba(248, 242, 223, 0) 42%),
      linear-gradient(180deg, #f7fbff 0%, #f2f5fa 48%, #eef2f7 100%);
  }

  :global(a:focus-visible),
  :global(button:focus-visible),
  :global(input:focus-visible),
  :global(select:focus-visible),
  :global(textarea:focus-visible) {
    outline: 3px solid var(--focus-ring-color);
    outline-offset: 2px;
    box-shadow: 0 0 0 3px var(--focus-ring-shadow);
  }

  :global([data-route-heading]:focus-visible) {
    outline: 3px solid var(--focus-ring-color);
    outline-offset: 2px;
    border-radius: 0.25rem;
  }

  .shell {
    max-width: 1160px;
    min-height: 100vh;
    margin: 0 auto;
    padding: 1rem 1.25rem 2.5rem;
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .skip-link {
    position: absolute;
    top: 0.5rem;
    left: 1.25rem;
    transform: translateY(-180%);
    z-index: 20;
    padding: 0.45rem 0.62rem;
    border-radius: 0.45rem;
    border: 1px solid #6f9fdd;
    background: #fff;
    color: #0b4ea2;
    font-weight: 700;
    text-decoration: none;
  }

  .skip-link:focus-visible {
    transform: translateY(0);
  }

  .shell-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 0.9rem;
    padding-bottom: 0.9rem;
    border-bottom: 1px solid #bcccdc;
  }

  .brand-block {
    display: grid;
    gap: 0.2rem;
  }

  .brand-link {
    margin: 0;
    text-decoration: none;
    color: #102a43;
    font-size: 1.5rem;
    font-weight: 750;
    letter-spacing: 0.01em;
  }

  .brand-block p {
    margin: 0;
    color: #486581;
    font-size: 0.92rem;
  }

  nav {
    display: flex;
    gap: 0.55rem;
    flex-wrap: nowrap;
  }

  nav a {
    color: #334e68;
    text-decoration: none;
    padding: 0.42rem 0.72rem;
    border-radius: 999px;
    border: 1px solid #d9e2ec;
    background: rgba(255, 255, 255, 0.82);
    font-size: 0.94rem;
    font-weight: 600;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  nav a:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  nav a.active {
    color: #0b4ea2;
    border-color: #6f9fdd;
    background: #e8f2ff;
  }

  .context-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    padding: 0.6rem 0;
  }

  .context-chip {
    margin: 0;
    display: grid;
    gap: 0.08rem;
    min-width: 9.2rem;
    padding: 0.42rem 0.62rem;
    border: 1px solid #d9e2ec;
    border-radius: 0.6rem;
    background: rgba(255, 255, 255, 0.9);
  }

  .context-chip span {
    color: #627d98;
    font-size: 0.72rem;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .context-chip strong {
    color: #102a43;
    font-size: 0.88rem;
    line-height: 1.2;
    font-weight: 650;
    word-break: break-word;
  }

  .content {
    display: grid;
    gap: 0.9rem;
    min-width: 0;
  }

  .content:focus {
    outline: none;
  }

  @media (max-width: 640px) {
    .shell {
      padding: 0.75rem 0.75rem 2rem;
      gap: 0.8rem;
    }

    .skip-link {
      left: 0.75rem;
    }

    .shell-header {
      align-items: start;
      flex-direction: column;
      gap: 0.7rem;
    }

    nav {
      width: 100%;
      flex-wrap: wrap;
      gap: 0.45rem;
    }

    nav a {
      flex: 1 1 calc(50% - 0.4rem);
      text-align: center;
      min-width: 5.5rem;
    }

    .context-strip {
      gap: 0.45rem;
      padding-top: 0.2rem;
    }

    .context-chip {
      flex: 1 1 8.4rem;
      min-width: 0;
    }
  }
</style>
