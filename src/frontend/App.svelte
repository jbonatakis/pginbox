<script lang="ts">
  import { tick } from "svelte";
  import AdminPage from "./pages/AdminPage.svelte";
  import AnalyticsPage from "./pages/AnalyticsPage.svelte";
  import AccountPage from "./pages/AccountPage.svelte";
  import ForgotPasswordPage from "./pages/ForgotPasswordPage.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import LoginPage from "./pages/LoginPage.svelte";
  import MessagePermalinkPage from "./pages/MessagePermalinkPage.svelte";
  import NotFoundPage from "./pages/NotFoundPage.svelte";
  import RegisterPage from "./pages/RegisterPage.svelte";
  import ResetPasswordPage from "./pages/ResetPasswordPage.svelte";
  import ThreadDetailPage from "./pages/ThreadDetailPage.svelte";
  import ThreadsPage from "./pages/ThreadsPage.svelte";
  import VerifyEmailPage from "./pages/VerifyEmailPage.svelte";
  import { buildAuthPath, getCurrentLocationRedirect } from "./lib/authRedirect";
  import { documentTitleForRoute } from "./lib/documentTitle";
  import { authStore } from "./lib/state/auth";
  import {
    accountPath,
    adminPath,
    analyticsPath,
    currentRoute,
    homePath,
    loginPath,
    onLinkClick,
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
    { label: "Threads", path: threadsPath, activeWhen: ["threads", "thread-detail", "message-permalink"] },
    { label: "Analytics", path: analyticsPath, activeWhen: ["analytics"] },
  ];

  const isActiveNavItem = (item: (typeof navItems)[number], routeName: AppRoute["name"]): boolean =>
    item.activeWhen.includes(routeName);

  const authRouteNames = new Set<AppRoute["name"]>([
    "login",
    "register",
    "verify-email",
    "forgot-password",
    "reset-password",
  ]);

  const clipped = (value: string, maxLength: number): string =>
    value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

  const contextChipsForRoute = (route: AppRoute): ContextChip[] => {
    if (route.name === "threads") {
      return [];
    }

    if (route.name === "thread-detail") {
      return [];
    }

    if (route.name === "message-permalink") {
      return [];
    }

    if (route.name === "analytics") {
      return [];
    }

    if (route.name === "account") {
      return [];
    }

    if (authRouteNames.has(route.name)) {
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
  let accountLink = accountPath;
  let loginLink = loginPath;
  let mobileNavOpen = false;
  let routeContextChips: ContextChip[] = [];

  const focusRouteHeading = async (): Promise<void> => {
    await tick();

    const heading = contentElement?.querySelector<HTMLElement>("[data-route-heading]");
    if (heading) {
      heading.focus();
      return;
    }

    contentElement?.focus();
  };

  const toggleMobileNav = (): void => {
    mobileNavOpen = !mobileNavOpen;
  };

  const closeMobileNav = (): void => {
    mobileNavOpen = false;
  };

  const syncAccountLinks = (route: AppRoute): void => {
    const nextRedirect = authRouteNames.has(route.name)
      ? homePath
      : getCurrentLocationRedirect(homePath);

    loginLink = buildAuthPath(loginPath, nextRedirect);
    accountLink = accountPath;
  };

  const handleWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;

    if (mobileNavOpen) {
      closeMobileNav();
    }
  };

  $: if (typeof document !== "undefined") {
    const route = $currentRoute;
    document.title = documentTitleForRoute(route);
    syncAccountLinks(route);

    if (route.pathname !== handledRoutePathname) {
      mobileNavOpen = false;
      handledRoutePathname = route.pathname;
      void focusRouteHeading();
    }
  }

  $: isAdmin = $authStore.user?.role === "admin";
  $: authNavActive = $authStore.isAuthenticated
    ? $currentRoute.name === "account"
    : $currentRoute.name === "login";
  $: authNavLabel = $authStore.isAuthenticated ? "My Account" : "Sign In";
  $: routeContextChips = contextChipsForRoute($currentRoute);
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div class="shell">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <header class="shell-header">
    <div class="header-bar">
      <div class="brand-block">
        <a href={homePath} class="brand-link" on:click={(event) => onLinkClick(event, homePath)}
          ><span class="brand-mark" aria-hidden="true">pg</span>
          <span class="brand-wordmark">pginbox</span></a
        >
        <p class="brand-tagline">Searchable PostgreSQL mailing list history</p>
      </div>

      <div class="header-tools">
        <div class="nav-popover">
          <button
            type="button"
            class="nav-toggle"
            aria-controls="primary-navigation"
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
            on:click={toggleMobileNav}
          >
            <span class="nav-toggle-text">Menu</span>
            <span class="nav-toggle-icon" aria-hidden="true">
              <span class:open={mobileNavOpen}></span>
              <span class:open={mobileNavOpen}></span>
              <span class:open={mobileNavOpen}></span>
            </span>
          </button>

          <nav
            id="primary-navigation"
            class="primary-nav"
            class:mobile-open={mobileNavOpen}
            aria-label="Primary navigation"
          >
            {#each navItems as item}
              <a
                href={item.path}
                class="nav-link"
                class:active={isActiveNavItem(item, $currentRoute.name)}
                aria-current={isActiveNavItem(item, $currentRoute.name) ? "page" : undefined}
                on:click={(event) => {
                  closeMobileNav();
                  onLinkClick(event, item.path);
                }}>{item.label}</a
              >
            {/each}

            {#if isAdmin}
              <a
                href={adminPath}
                class="nav-link"
                class:active={$currentRoute.name === "admin"}
                aria-current={$currentRoute.name === "admin" ? "page" : undefined}
                on:click={(event) => {
                  closeMobileNav();
                  onLinkClick(event, adminPath);
                }}>Admin</a
              >
            {/if}

            <a
              href={$authStore.isAuthenticated ? accountLink : loginLink}
              class="nav-link auth-link"
              class:active={authNavActive}
              on:click={(event) => {
                closeMobileNav();
                onLinkClick(event, $authStore.isAuthenticated ? accountLink : loginLink);
              }}>{authNavLabel}</a
            >
          </nav>
        </div>
      </div>
    </div>
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
    {:else if $currentRoute.name === "message-permalink"}
      <MessagePermalinkPage messageId={$currentRoute.params.messageId} />
    {:else if $currentRoute.name === "analytics"}
      <AnalyticsPage />
    {:else if $currentRoute.name === "account"}
      <AccountPage />
    {:else if $currentRoute.name === "admin"}
      <AdminPage />
    {:else if $currentRoute.name === "login"}
      <LoginPage />
    {:else if $currentRoute.name === "register"}
      <RegisterPage />
    {:else if $currentRoute.name === "verify-email"}
      <VerifyEmailPage />
    {:else if $currentRoute.name === "forgot-password"}
      <ForgotPasswordPage />
    {:else if $currentRoute.name === "reset-password"}
      <ResetPasswordPage />
    {:else}
      <NotFoundPage pathname={$currentRoute.pathname} />
    {/if}
  </main>
</div>

<style>
  :global(:root) {
    --bg: #f3f6fb;
    --bg-elevated: #ffffff;
    --text: #102a43;
    --text-muted: #526b84;
    --text-subtle: #304a64;
    --border: #c9d6e4;
    --border-soft: #dfe7f0;
    --surface-soft: rgba(255, 255, 255, 0.92);
    --surface-muted: #f3f8ff;
    --primary: #0b4ea2;
    --primary-hover: #0c5abf;
    --primary-soft: #e8f2ff;
    --danger: #8a1c1c;
    --danger-soft: #fff6f6;
    --danger-border: #e7b4b8;
    --focus-ring-color: var(--primary);
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
    color: var(--text);
    background:
      radial-gradient(circle at 8% 0%, #dce9fb 0%, rgba(220, 233, 251, 0) 37%),
      radial-gradient(circle at 94% 5%, #eaf1fd 0%, rgba(234, 241, 253, 0) 42%),
      linear-gradient(180deg, #f9fbfe 0%, var(--bg) 55%, #edf2f9 100%);
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
    padding: 0.85rem 1.25rem 2.5rem;
    display: grid;
    align-content: start;
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
    padding-bottom: 0.72rem;
    border-bottom: 1px solid rgba(126, 151, 177, 0.4);
  }

  .header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.9rem;
    min-width: 0;
  }

  .header-tools {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    min-width: 0;
  }

  .nav-popover {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .brand-block {
    display: grid;
    gap: 0.14rem;
    min-width: 0;
  }

  .brand-link {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.56rem;
    width: fit-content;
    text-decoration: none;
    color: var(--text);
    transition:
      color 120ms ease,
      transform 120ms ease;
  }

  .brand-link:hover {
    color: var(--primary);
    transform: translateY(-1px);
  }

  .brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.52rem;
    height: 1.52rem;
    padding: 0 0.42rem;
    border-radius: 0.45rem;
    background: linear-gradient(145deg, var(--primary), #1865c7);
    color: #fff;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    font-family:
      "IBM Plex Mono",
      "SFMono-Regular",
      Menlo,
      monospace;
  }

  .brand-wordmark {
    font-size: 1.3rem;
    line-height: 1;
    font-weight: 760;
    letter-spacing: 0.015em;
    text-transform: lowercase;
  }

  .brand-tagline {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.78rem;
    letter-spacing: 0.012em;
  }

  .nav-toggle {
    display: none;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .nav-toggle-text {
    white-space: nowrap;
  }

  .nav-toggle-icon {
    width: 1rem;
    height: 0.8rem;
    display: grid;
    align-content: center;
    gap: 0.18rem;
  }

  .nav-toggle-icon span {
    display: block;
    width: 100%;
    height: 2px;
    border-radius: 999px;
    background: currentColor;
    transition:
      transform 140ms ease,
      opacity 140ms ease;
    transform-origin: center;
  }

  .primary-nav {
    display: flex;
    gap: 0.32rem;
    flex-wrap: nowrap;
    align-items: center;
    padding: 0.2rem;
    border: 1px solid rgba(126, 151, 177, 0.36);
    border-radius: 0.74rem;
    background: rgba(255, 255, 255, 0.66);
    backdrop-filter: blur(6px);
  }

  .nav-link {
    color: #304a64;
    text-decoration: none;
    padding: 0.33rem 0.64rem;
    border-radius: 0.5rem;
    border: 1px solid transparent;
    background: transparent;
    font-size: 0.85rem;
    font-weight: 640;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .nav-link:hover {
    background: rgba(232, 242, 255, 0.9);
    border-color: rgba(111, 159, 221, 0.46);
    color: #1f3d5a;
  }

  .nav-link.active {
    color: var(--primary);
    border-color: rgba(111, 159, 221, 0.76);
    background: rgba(232, 242, 255, 0.96);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.8);
  }

  .auth-link {
    margin-left: 0.08rem;
    border-left: 1px solid rgba(126, 151, 177, 0.35);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding-left: 0.74rem;
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
      padding: 0.65rem 0.75rem 2rem;
      gap: 0.8rem;
    }

    .skip-link {
      left: 0.75rem;
    }

    .shell-header {
      padding-bottom: 0.62rem;
    }

    .header-bar {
      flex-direction: row;
      align-items: center;
    }

    .header-tools {
      width: auto;
      flex-shrink: 0;
    }

    .brand-block {
      flex: 1 1 auto;
    }

    .brand-mark {
      min-width: 1.5rem;
      height: 1.5rem;
      font-size: 0.62rem;
    }

    .brand-wordmark {
      font-size: 1.28rem;
    }

    .brand-tagline {
      font-size: 0.76rem;
    }

    .nav-toggle {
      display: inline-flex;
      flex-shrink: 0;
    }

    .nav-toggle-icon span.open:nth-child(1) {
      transform: translateY(0.31rem) rotate(45deg);
    }

    .nav-toggle-icon span.open:nth-child(2) {
      opacity: 0;
    }

    .nav-toggle-icon span.open:nth-child(3) {
      transform: translateY(-0.31rem) rotate(-45deg);
    }

    .primary-nav {
      position: absolute;
      top: calc(100% + 0.45rem);
      right: 0;
      display: none;
      justify-content: stretch;
      gap: 0.45rem;
      width: min(14rem, calc(100vw - 1.5rem));
      padding: 0.45rem;
      border: 1px solid #cdd7e1;
      border-radius: 1rem;
      background: rgba(255, 255, 255, 0.98);
      box-shadow:
        0 20px 45px -28px rgba(16, 42, 67, 0.45),
        0 8px 18px -16px rgba(16, 42, 67, 0.35);
      z-index: 30;
      backdrop-filter: none;
    }

    .primary-nav.mobile-open {
      display: grid;
    }

    .nav-popover {
      justify-content: flex-end;
    }

    .nav-link {
      width: 100%;
      text-align: left;
      padding: 0.7rem 0.85rem;
      border-radius: 0.8rem;
    }

    .auth-link {
      margin-left: 0;
      border-left: 0;
      border-top: 1px solid rgba(126, 151, 177, 0.35);
      border-top-left-radius: 0.8rem;
      border-top-right-radius: 0.8rem;
      padding-left: 0.85rem;
      margin-top: 0.15rem;
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
