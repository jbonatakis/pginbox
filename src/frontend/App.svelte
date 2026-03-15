<script lang="ts">
  import { tick } from "svelte";
  import AnalyticsPage from "./pages/AnalyticsPage.svelte";
  import ForgotPasswordPage from "./pages/ForgotPasswordPage.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import LoginPage from "./pages/LoginPage.svelte";
  import NotFoundPage from "./pages/NotFoundPage.svelte";
  import PeoplePage from "./pages/PeoplePage.svelte";
  import PersonDetailPage from "./pages/PersonDetailPage.svelte";
  import RegisterPage from "./pages/RegisterPage.svelte";
  import ResetPasswordPage from "./pages/ResetPasswordPage.svelte";
  import ThreadDetailPage from "./pages/ThreadDetailPage.svelte";
  import ThreadsPage from "./pages/ThreadsPage.svelte";
  import VerifyEmailPage from "./pages/VerifyEmailPage.svelte";
  import { buildAuthPath, getCurrentLocationRedirect } from "./lib/authRedirect";
  import { toApiErrorShape } from "./lib/api";
  import { authStore } from "./lib/state/auth";
  import {
    analyticsPath,
    currentRoute,
    homePath,
    loginPath,
    navigate,
    onLinkClick,
    peoplePath,
    registerPath,
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

    if (route.name === "people") {
      return [];
    }

    if (route.name === "person-detail") {
      return [];
    }

    if (route.name === "analytics") {
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
  let loginLink = loginPath;
  let logoutError: string | null = null;
  let mobileNavOpen = false;
  let registerLink = registerPath;
  let routeContextChips: ContextChip[] = [];

  const documentTitleForRoute = (route: AppRoute): string => {
    if (route.name === "home") return "pginbox | PostgreSQL mailing list archive";
    if (route.name === "threads") return "Threads | pginbox";
    if (route.name === "thread-detail") return `Thread ${clipped(route.params.threadId, 48)} | pginbox`;
    if (route.name === "people") return "People | pginbox";
    if (route.name === "person-detail") return `Person ${clipped(route.params.id, 40)} | pginbox`;
    if (route.name === "analytics") return "Analytics | pginbox";
    if (route.name === "login") return "Log in | pginbox";
    if (route.name === "register") return "Register | pginbox";
    if (route.name === "verify-email") return "Verify email | pginbox";
    if (route.name === "forgot-password") return "Forgot password | pginbox";
    if (route.name === "reset-password") return "Reset password | pginbox";
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
    registerLink = buildAuthPath(registerPath, nextRedirect);
  };

  const handleLogout = async (): Promise<void> => {
    logoutError = null;

    try {
      await authStore.logout();

      if (authRouteNames.has($currentRoute.name)) {
        navigate(homePath, { replace: true });
      }
    } catch (error) {
      logoutError = toApiErrorShape(error).message;
    }
  };

  $: if (typeof document !== "undefined") {
    const route = $currentRoute;
    document.title = documentTitleForRoute(route);
    syncAccountLinks(route);

    if (route.pathname !== handledRoutePathname) {
      mobileNavOpen = false;
      logoutError = null;
      handledRoutePathname = route.pathname;
      void focusRouteHeading();
    }
  }

  $: accountLabel = $authStore.user?.displayName?.trim() || $authStore.user?.email || "Account";
  $: isLoggingOut = $authStore.currentAction === "logout";
  $: routeContextChips = contextChipsForRoute($currentRoute);
</script>

<div class="shell">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <header class="shell-header">
    <div class="header-bar">
      <div class="brand-block">
        <a href={homePath} class="brand-link" on:click={(event) => onLinkClick(event, homePath)}
          >pginbox</a
        >
        <p>Searchable PostgreSQL mailing list history</p>
      </div>

      <div class="header-tools">
        <section class="account-control" aria-label="Account">
          <p class="account-label">Account</p>

          {#if $authStore.bootstrapStatus === "loading" && !$authStore.isBootstrapped}
            <p class="account-summary">Checking session...</p>
          {:else if $authStore.isAuthenticated}
            <p class="account-summary">
              Signed in as <strong>{accountLabel}</strong>
            </p>

            <div class="account-actions">
              {#if $authStore.user?.status === "pending_verification"}
                <span class="account-badge">Email pending</span>
              {/if}

              <button
                type="button"
                class="account-button"
                disabled={isLoggingOut}
                on:click={handleLogout}>{isLoggingOut ? "Logging out..." : "Log out"}</button
              >
            </div>
          {:else}
            <p class="account-summary">Browsing anonymously</p>

            <div class="account-actions">
              <a href={loginLink} class="account-link" on:click={(event) => onLinkClick(event, loginLink)}
                >Log in</a
              >
              <a
                href={registerLink}
                class="account-link secondary"
                on:click={(event) => onLinkClick(event, registerLink)}>Register</a
              >
            </div>
          {/if}

          {#if logoutError}
            <p class="account-note error">{logoutError}</p>
          {:else if $authStore.bootstrapStatus === "error" && !$authStore.isAuthenticated}
            <p class="account-note">Session check failed. Public archive pages still work.</p>
          {/if}
        </section>

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
            class:mobile-open={mobileNavOpen}
            aria-label="Primary navigation"
          >
            {#each navItems as item}
              <a
                href={item.path}
                class:active={isActiveNavItem(item, $currentRoute.name)}
                aria-current={isActiveNavItem(item, $currentRoute.name) ? "page" : undefined}
                on:click={(event) => {
                  closeMobileNav();
                  onLinkClick(event, item.path);
                }}>{item.label}</a
              >
            {/each}
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
    {:else if $currentRoute.name === "people"}
      <PeoplePage />
    {:else if $currentRoute.name === "person-detail"}
      <PersonDetailPage id={$currentRoute.params.id} />
    {:else if $currentRoute.name === "analytics"}
      <AnalyticsPage />
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
    padding-bottom: 0.9rem;
    border-bottom: 1px solid #bcccdc;
  }

  .header-bar {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 0.9rem;
    min-width: 0;
  }

  .header-tools {
    display: grid;
    gap: 0.7rem;
    justify-items: end;
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

  .account-control {
    min-width: min(100%, 19rem);
    display: grid;
    gap: 0.32rem;
    padding: 0.72rem 0.85rem;
    border: 1px solid #d9e2ec;
    border-radius: 0.95rem;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 12px 30px -28px rgba(16, 42, 67, 0.42);
  }

  .account-label {
    margin: 0;
    color: #627d98;
    font-size: 0.72rem;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .account-summary {
    margin: 0;
    color: #102a43;
    font-size: 0.92rem;
    line-height: 1.4;
  }

  .account-summary strong {
    font-weight: 700;
  }

  .account-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }

  .account-link,
  .account-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.1rem;
    padding: 0.38rem 0.75rem;
    border-radius: 999px;
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
    font-size: 0.87rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
  }

  .account-link.secondary {
    border-color: #d9e2ec;
    background: rgba(255, 255, 255, 0.92);
    color: #243b53;
  }

  .account-link:hover,
  .account-button:hover {
    background: #dcebff;
  }

  .account-link.secondary:hover {
    background: #f5f8fb;
  }

  .account-button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .account-badge {
    display: inline-flex;
    align-items: center;
    min-height: 2.1rem;
    padding: 0.38rem 0.72rem;
    border-radius: 999px;
    border: 1px solid #f2d58a;
    background: #fff7df;
    color: #8b6200;
    font-size: 0.82rem;
    font-weight: 700;
  }

  .account-note {
    margin: 0;
    color: #486581;
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .account-note.error {
    color: #8a1c1c;
  }

  .nav-toggle {
    display: none;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid #c5d0da;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    color: #243b53;
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
      padding-bottom: 0.7rem;
    }

    .header-bar {
      flex-direction: column;
      align-items: stretch;
    }

    .header-tools {
      justify-items: stretch;
      width: 100%;
    }

    .account-control {
      min-width: 0;
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

    nav {
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
    }

    nav.mobile-open {
      display: grid;
    }

    .nav-popover {
      justify-content: flex-end;
    }

    nav a {
      width: 100%;
      text-align: left;
      padding: 0.7rem 0.85rem;
      border-radius: 0.8rem;
    }

    .account-actions {
      align-items: stretch;
    }

    .account-link,
    .account-button,
    .account-badge {
      width: 100%;
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
