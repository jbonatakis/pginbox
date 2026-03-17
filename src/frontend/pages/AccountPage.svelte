<script lang="ts">
  import { onDestroy } from "svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import SuccessState from "../components/SuccessState.svelte";
  import { buildAuthPath } from "../lib/authRedirect";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { authStore } from "../lib/state/auth";
  import { accountPath, forgotPasswordPath, homePath, loginPath, navigate, onLinkClick, threadDetailPath } from "../router";
  import type { FollowedThread } from "shared/api";

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  let followedThreads: FollowedThread[] = [];
  let followedThreadsError: ApiErrorShape | null = null;
  let followedThreadsFetched = false;
  let followedThreadsLoading = false;
  let followedThreadsLoadingMore = false;
  let followedThreadsNextCursor: string | null = null;
  let logoutError: ApiErrorShape | null = null;
  let profileDisplayName = "";
  let profileError: ApiErrorShape | null = null;
  let profileMessage: string | null = null;
  let resendError: ApiErrorShape | null = null;
  let resendMessage: string | null = null;
  let redirectTimer: number | null = null;
  let syncedDisplayName: string | null = null;

  const forgotPasswordLink = buildAuthPath(forgotPasswordPath, accountPath);
  const loginLink = buildAuthPath(loginPath, accountPath);

  const clearRedirectTimer = (): void => {
    if (redirectTimer === null) return;
    clearTimeout(redirectTimer);
    redirectTimer = null;
  };

  const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "Unknown";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return dateFormatter.format(parsed);
  };

  const describeStatus = (
    status: "active" | "disabled" | "pending_verification"
  ): { label: string; tone: "neutral" | "warning" } => {
    if (status === "pending_verification") {
      return { label: "Email verification pending", tone: "warning" };
    }

    if (status === "disabled") {
      return { label: "Account disabled", tone: "warning" };
    }

    return { label: "Active account", tone: "neutral" };
  };

  const formatErrorDetail = (error: ApiErrorShape | null): string | null => {
    if (!error) return null;

    if (error.status > 0) {
      return `${error.method} ${error.path || "/api"} -> ${error.status}`;
    }

    return `${error.method} ${error.path || "/api"} -> ${error.code ?? "NETWORK_ERROR"}`;
  };

  const formatVerificationTooltip = (value: string | null | undefined): string | null => {
    if (!value) return null;
    return `Verified since ${formatDateTime(value)}`;
  };

  const handleLogout = async (): Promise<void> => {
    logoutError = null;

    try {
      await authStore.logout();
      navigate(homePath, { replace: true });
    } catch (error) {
      logoutError = toApiErrorShape(error);
    }
  };

  const handleProfileSubmit = async (): Promise<void> => {
    profileError = null;
    profileMessage = null;

    const normalizedDisplayName = profileDisplayName.trim();

    try {
      const response = await authStore.updateProfile({
        displayName: normalizedDisplayName || null,
      });

      const nextDisplayName = response.user.displayName ?? "";
      profileDisplayName = nextDisplayName;
      syncedDisplayName = nextDisplayName;
      profileMessage =
        nextDisplayName.length > 0
          ? "Display name updated."
          : "Display name cleared. Your email will be used when a name is unavailable.";
    } catch (error) {
      profileError = toApiErrorShape(error);
    }
  };

  const handleResendVerification = async (): Promise<void> => {
    const email = $authStore.user?.email?.trim() ?? "";
    if (!email) return;

    resendError = null;
    resendMessage = null;

    try {
      const response = await authStore.resendVerification({ email });
      resendMessage = response.message;
    } catch (error) {
      resendError = toApiErrorShape(error);
    }
  };

  $: if (typeof window !== "undefined" && $authStore.isBootstrapped && !$authStore.isAuthenticated) {
    clearRedirectTimer();
    redirectTimer = window.setTimeout(() => {
      navigate(loginLink, { replace: true });
    }, 0);
  }

  $: currentUser = $authStore.user;
  $: isLoggingOut = $authStore.currentAction === "logout";
  $: isUpdatingProfile = $authStore.currentAction === "update-profile";
  $: isResending = $authStore.currentAction === "resend-verification";
  $: statusDescriptor = currentUser ? describeStatus(currentUser.status) : null;
  $: currentUserLabel = currentUser?.displayName?.trim() || currentUser?.email || "Account";
  $: currentUserDisplayName = currentUser?.displayName?.trim() || "";
  $: verificationTooltip = formatVerificationTooltip(currentUser?.emailVerifiedAt);
  $: if (currentUser && syncedDisplayName !== currentUserDisplayName && !isUpdatingProfile) {
    profileDisplayName = currentUserDisplayName;
    syncedDisplayName = currentUserDisplayName;
  }
  $: normalizedProfileDisplayName = profileDisplayName.trim();
  $: isProfileDirty = (normalizedProfileDisplayName || null) !== (currentUserDisplayName || null);

  $: if (currentUser && !followedThreadsFetched) {
    followedThreadsFetched = true;
    void loadFollowedThreads();
  }

  function resumeUrl(thread: FollowedThread): string {
    const base = threadDetailPath(thread.thread_id);
    if (thread.has_unread && thread.resume_page !== null && thread.first_unread_message_id !== null) {
      return `${base}?page=${thread.resume_page}#message-${thread.first_unread_message_id}`;
    }
    return `${base}?page=${thread.latest_page}`;
  }

  function latestUrl(thread: FollowedThread): string {
    return threadDetailPath(thread.thread_id);
  }

  async function loadFollowedThreads(): Promise<void> {
    followedThreadsLoading = true;
    followedThreadsError = null;
    try {
      const result = await api.me.followedThreads();
      followedThreads = result.items;
      followedThreadsNextCursor = result.nextCursor;
    } catch (error) {
      followedThreadsError = toApiErrorShape(error);
    } finally {
      followedThreadsLoading = false;
    }
  }

  async function loadMoreFollowedThreads(): Promise<void> {
    if (!followedThreadsNextCursor) return;
    followedThreadsLoadingMore = true;
    try {
      const result = await api.me.followedThreads({ cursor: followedThreadsNextCursor });
      followedThreads = [...followedThreads, ...result.items];
      followedThreadsNextCursor = result.nextCursor;
    } catch (error) {
      followedThreadsError = toApiErrorShape(error);
    } finally {
      followedThreadsLoadingMore = false;
    }
  }

  onDestroy(() => {
    clearRedirectTimer();
  });
</script>

<section class="account-page">
  <h1 class="page-title" data-route-heading tabindex="-1">My Account</h1>

  {#if !$authStore.isBootstrapped || $authStore.isBootstrapping}
    <LoadingState
      title="Loading account"
      message="Checking your current session and account state."
    />
  {:else if !$authStore.isAuthenticated}
    <LoadingState
      title="Redirecting to login"
      message="You need to sign in before opening the account page."
    />
  {:else if currentUser}
    <section class="account-grid" aria-label="Account summary and actions">
      <article class="account-card">
        <header class="card-header">
          <div>
            <p class="eyebrow">Account</p>
            <h2>{currentUserLabel}</h2>
          </div>
          {#if statusDescriptor}
            <p class:warning={statusDescriptor.tone === "warning"} class="status-pill">
              {statusDescriptor.label}
            </p>
          {/if}
        </header>

        <dl class="facts">
          <div>
            <dt>Email</dt>
            <dd class="email-row">
              <span>{currentUser.email}</span>
              {#if verificationTooltip}
                <button
                  type="button"
                  class="verification-indicator"
                  title={verificationTooltip}
                  aria-label={verificationTooltip}
                >
                  <span class="verification-dot" aria-hidden="true"></span>
                  Verified
                </button>
              {/if}
            </dd>
          </div>

          <div>
            <dt>Member since</dt>
            <dd>{formatDateTime(currentUser.createdAt)}</dd>
          </div>
        </dl>

        {#if currentUser.status === "pending_verification"}
          <p class="inline-status warning" role="status">
            This account is still waiting on email verification.
          </p>

          <div class="actions">
            <button
              type="button"
              class="primary-button"
              disabled={isResending}
              on:click={handleResendVerification}
            >
              {isResending ? "Sending..." : "Resend verification email"}
            </button>
          </div>

          {#if resendError}
            <ErrorState
              title="Unable to resend verification"
              message={resendError.message}
              detail={formatErrorDetail(resendError)}
            />
          {/if}

          {#if resendMessage}
            <SuccessState
              title="Verification email queued"
              message={resendMessage}
              detail={currentUser.email}
            />
          {/if}
        {/if}
      </article>

      <article class="account-card">
        <header class="card-header stacked">
          <div>
            <p class="eyebrow">Profile</p>
            <h2>Display name</h2>
          </div>
          <p class="support-copy">
            This name appears anywhere pginbox needs a human-readable label for your account.
          </p>
        </header>

        {#if profileError}
          <ErrorState
            title="Unable to update profile"
            message={profileError.message}
            detail={formatErrorDetail(profileError)}
          />
        {/if}

        {#if profileMessage}
          <SuccessState
            title="Profile updated"
            message={profileMessage}
          />
        {/if}

        <form class="profile-form" on:submit|preventDefault={handleProfileSubmit}>
          <label class="field">
            <span>Display name</span>
            <input
              name="displayName"
              autocomplete="nickname"
              bind:value={profileDisplayName}
              maxlength="120"
              placeholder="Optional display name"
            />
          </label>

          <p class="field-hint">
            Leave it blank to fall back to your email address in account surfaces.
          </p>

          <div class="actions">
            <button
              type="submit"
              class="primary-button"
              disabled={isUpdatingProfile || !isProfileDirty}
            >
              {isUpdatingProfile ? "Saving..." : "Save display name"}
            </button>
          </div>
        </form>
      </article>

      <article class="account-card">
        <header class="card-header stacked">
          <div>
            <p class="eyebrow">Session</p>
            <h2>Current device</h2>
          </div>
          <p class="support-copy">This browser is signed into your pginbox account.</p>
        </header>

        {#if logoutError}
          <ErrorState
            title="Unable to log out"
            message={logoutError.message}
            detail={formatErrorDetail(logoutError)}
          />
        {/if}

        <div class="actions">
          <button type="button" class="primary-button" disabled={isLoggingOut} on:click={handleLogout}>
            {isLoggingOut ? "Logging out..." : "Log out"}
          </button>

          <a href={forgotPasswordLink} class="secondary-link" on:click={(event) => onLinkClick(event, forgotPasswordLink)}>
            Reset password
          </a>
        </div>
      </article>

    </section>

    <section class="followed-threads-section" aria-label="Followed threads">
      <h2 class="section-heading">Followed Threads</h2>

      {#if followedThreadsLoading}
        <LoadingState title="Loading followed threads" message="Fetching your followed threads." />
      {:else if followedThreadsError}
        <ErrorState
          title="Unable to load followed threads"
          message={followedThreadsError.message}
          detail={formatErrorDetail(followedThreadsError)}
        />
      {:else if followedThreads.length === 0}
        <p class="empty-state">No followed threads yet.</p>
      {:else}
        <ul class="followed-threads-list">
          {#each followedThreads as thread (thread.thread_id)}
            <li class="thread-item">
              <div class="thread-subject-row">
                <a
                  href={resumeUrl(thread)}
                  class="thread-subject"
                  class:has-unread={thread.has_unread}
                  on:click={(e) => onLinkClick(e, resumeUrl(thread))}
                >{thread.subject ?? "(No subject)"}</a>
                {#if thread.has_unread}
                  <span class="unread-badge" aria-label="{thread.unread_count} unread">{thread.unread_count}</span>
                {/if}
              </div>
              <div class="thread-meta">
                <span class="thread-list-name">{thread.list_name}</span>
                <span class="thread-activity">{formatDateTime(thread.last_activity_at)}</span>
                <a
                  href={latestUrl(thread)}
                  class="thread-latest-link"
                  on:click={(e) => onLinkClick(e, latestUrl(thread))}
                >Latest</a>
              </div>
            </li>
          {/each}
        </ul>
        {#if followedThreadsNextCursor}
          <div class="load-more">
            <button
              type="button"
              class="primary-button"
              disabled={followedThreadsLoadingMore}
              on:click={loadMoreFollowedThreads}
            >{followedThreadsLoadingMore ? "Loading..." : "Load more"}</button>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</section>

<style>
  .account-page {
    display: grid;
    gap: 0.85rem;
    min-width: 0;
  }

  .page-title {
    margin: 0;
    color: #102a43;
    font-size: 1.45rem;
    line-height: 1.1;
  }

  .account-grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    min-width: 0;
  }

  .account-card {
    display: grid;
    gap: 0.8rem;
    padding: 1rem;
    border: 1px solid #d9e2ec;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 18px 34px -28px rgba(16, 42, 67, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.9);
    min-width: 0;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: start;
  }

  .card-header.stacked {
    display: grid;
    gap: 0.35rem;
  }

  .eyebrow {
    margin: 0 0 0.15rem;
    color: #627d98;
    font-size: 0.72rem;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  h2 {
    margin: 0;
    color: #102a43;
    font-size: 1.08rem;
    line-height: 1.2;
  }

  .support-copy,
  .inline-status {
    margin: 0;
    color: #486581;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .facts {
    display: grid;
    gap: 0.7rem;
    margin: 0;
  }

  .facts div {
    display: grid;
    gap: 0.18rem;
  }

  dt {
    color: #627d98;
    font-size: 0.75rem;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    color: #102a43;
    font-size: 0.95rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .email-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }

  .verification-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    min-height: 1.75rem;
    padding: 0.18rem 0.55rem;
    border: 1px solid #9fd5b3;
    border-radius: 999px;
    background: #eefbf1;
    color: #1f6f43;
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1;
    cursor: help;
    white-space: nowrap;
    font: inherit;
  }

  .verification-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: currentColor;
    flex: 0 0 auto;
  }

  .status-pill {
    margin: 0;
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid #c5d0da;
    background: #f8fbff;
    color: #334e68;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .status-pill.warning,
  .inline-status.warning {
    color: #8b6200;
  }

  .status-pill.warning {
    border-color: #f2d58a;
    background: #fff7df;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    align-items: center;
  }

  .primary-button,
  .secondary-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0.52rem 0.88rem;
    border-radius: 999px;
    font-size: 0.9rem;
    font-weight: 700;
    line-height: 1;
    text-decoration: none;
  }

  .primary-button {
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
    cursor: pointer;
  }

  .primary-button:hover {
    background: #dcebff;
  }

  .primary-button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .secondary-link {
    border: 1px solid #d9e2ec;
    background: rgba(255, 255, 255, 0.88);
    color: #334e68;
  }

  .secondary-link:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .profile-form {
    display: grid;
    gap: 0.65rem;
  }

  .field {
    display: grid;
    gap: 0.3rem;
  }

  .field span {
    color: #486581;
    font-size: 0.88rem;
    font-weight: 600;
    line-height: 1.2;
  }

  .field input {
    min-height: 2.7rem;
    width: 100%;
    padding: 0.7rem 0.82rem;
    border: 1px solid #bcccdc;
    border-radius: 0.8rem;
    background: rgba(255, 255, 255, 0.96);
    color: #102a43;
    font: inherit;
  }

  .field input::placeholder {
    color: #829ab1;
  }

  .field-hint {
    margin: 0;
    color: #627d98;
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .followed-threads-section {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    border: 1px solid #d9e2ec;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 18px 34px -28px rgba(16, 42, 67, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.9);
    min-width: 0;
  }

  .section-heading {
    margin: 0;
    color: #102a43;
    font-size: 1.08rem;
    line-height: 1.2;
  }

  .empty-state {
    margin: 0;
    color: #627d98;
    font-size: 0.92rem;
  }

  .followed-threads-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0;
  }

  .thread-item {
    display: grid;
    gap: 0.28rem;
    padding: 0.65rem 0;
    border-bottom: 1px solid #e8edf3;
  }

  .thread-item:last-child {
    border-bottom: none;
  }

  .thread-subject-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .thread-subject {
    color: #334e68;
    font-size: 0.95rem;
    line-height: 1.4;
    text-decoration: none;
    word-break: break-word;
  }

  .thread-subject:hover {
    color: #0b4ea2;
    text-decoration: underline;
  }

  .thread-subject.has-unread {
    font-weight: 700;
    color: #102a43;
  }

  .unread-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.35rem;
    height: 1.35rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: #0b4ea2;
    color: #fff;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1;
    flex-shrink: 0;
  }

  .thread-meta {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  .thread-list-name {
    color: #627d98;
    font-size: 0.8rem;
  }

  .thread-activity {
    color: #829ab1;
    font-size: 0.8rem;
  }

  .thread-latest-link {
    margin-left: auto;
    color: #486581;
    font-size: 0.8rem;
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    white-space: nowrap;
  }

  .thread-latest-link:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .load-more {
    display: flex;
    justify-content: center;
    padding-top: 0.25rem;
  }

  @media (max-width: 640px) {
    .account-card {
      padding: 0.9rem;
    }

    .card-header {
      grid-template-columns: 1fr;
      display: grid;
    }

    .status-pill {
      justify-self: start;
      white-space: normal;
    }

    .actions {
      align-items: stretch;
    }

    .primary-button,
    .secondary-link {
      width: 100%;
    }
  }
</style>
