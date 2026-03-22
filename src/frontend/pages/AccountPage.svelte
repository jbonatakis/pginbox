<script lang="ts">
  import { onDestroy } from "svelte";
  import TrackedThreadList from "../components/account/TrackedThreadList.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import SuccessState from "../components/SuccessState.svelte";
  import { buildAuthPath } from "../lib/authRedirect";
  import {
    addAccountEmail,
    listAccountEmails,
    makeAccountEmailPrimary,
    removeAccountEmail,
    resendAccountEmailVerification,
    toApiErrorShape,
    type ApiErrorShape,
  } from "../lib/api";
  import { authStore } from "../lib/state/auth";
  import {
    createTrackedThreadTabsController,
    getTrackedThreadEmptyMessage,
    getTrackedThreadTabLabel,
    TRACKED_THREAD_TABS,
    type TrackedThreadTab,
  } from "../lib/trackedThreads";
  import type { UserEmail } from "shared/api";
  import { accountPath, forgotPasswordPath, homePath, loginPath, navigate, onLinkClick } from "../router";

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  let isEditingDisplayName = false;
  let logoutError: ApiErrorShape | null = null;
  let profileDisplayName = "";
  let profileError: ApiErrorShape | null = null;
  let profileMessage: string | null = null;
  let resendError: ApiErrorShape | null = null;
  let resendMessage: string | null = null;
  let redirectTimer: number | null = null;
  let syncedDisplayName: string | null = null;
  let trackedThreadUserId: string | null = null;

  // Email management state
  let emails: UserEmail[] = [];
  let emailsLoading = false;
  let emailsError: ApiErrorShape | null = null;
  let emailsLoadedForUserId: string | null = null;
  let addEmailValue = "";
  let addEmailError: ApiErrorShape | null = null;
  let addEmailMessage: string | null = null;
  let addEmailBusy = false;
  let emailActionBusy: string | null = null; // emailId of in-progress action
  let emailActionError: ApiErrorShape | null = null;
  let confirmMakePrimaryId: string | null = null; // emailId awaiting confirmation
  let confirmRemoveId: string | null = null; // emailId awaiting remove confirmation
  let emailsDialog: HTMLDialogElement;

  const trackedThreadTabs = createTrackedThreadTabsController();
  const trackedThreadTabsStore = trackedThreadTabs.state;

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
      isEditingDisplayName = false;
      profileMessage =
        nextDisplayName.length > 0
          ? "Display name updated."
          : "Display name cleared. Your email will be used when a name is unavailable.";
    } catch (error) {
      profileError = toApiErrorShape(error);
    }
  };

  const cancelEditDisplayName = (): void => {
    isEditingDisplayName = false;
    profileDisplayName = syncedDisplayName ?? "";
    profileError = null;
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
  $: accountInitials = (() => {
    const name = currentUser?.displayName?.trim();
    if (name) {
      const parts = name.split(/\s+/);
      return parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    }
    return (currentUser?.email ?? "?").slice(0, 2).toUpperCase();
  })();
  $: verificationTooltip = formatVerificationTooltip(currentUser?.emailVerifiedAt);
  $: if (currentUser && syncedDisplayName !== currentUserDisplayName && !isUpdatingProfile) {
    profileDisplayName = currentUserDisplayName;
    syncedDisplayName = currentUserDisplayName;
  }
  $: normalizedProfileDisplayName = profileDisplayName.trim();
  $: isProfileDirty = (normalizedProfileDisplayName || null) !== (currentUserDisplayName || null);

  $: currentUserId = currentUser?.id ?? null;
  $: activeTrackedThreadTab = $trackedThreadTabsStore.activeTab;
  $: activeTrackedThreadState = $trackedThreadTabsStore.tabs[activeTrackedThreadTab];
  $: trackedThreadCountsError = $trackedThreadTabsStore.countsError;
  $: trackedThreadCountsLoading = $trackedThreadTabsStore.countsLoading;
  $: if (currentUserId && trackedThreadUserId !== currentUserId) {
    trackedThreadUserId = currentUserId;
    trackedThreadTabs.reset();
    void trackedThreadTabs.initialize();
  }
  $: if (!currentUserId && trackedThreadUserId !== null) {
    trackedThreadUserId = null;
    trackedThreadTabs.reset();
  }

  const handleTrackedThreadTabSelect = (tab: TrackedThreadTab): void => {
    void trackedThreadTabs.activateTab(tab);
  };

  const handleTrackedThreadLoadMore = (tab: TrackedThreadTab): void => {
    void trackedThreadTabs.loadMore(tab);
  };

  const loadEmails = async (): Promise<void> => {
    emailsLoading = true;
    emailsError = null;
    try {
      const response = await listAccountEmails();
      emails = response.emails;
    } catch (error) {
      emailsError = toApiErrorShape(error);
    } finally {
      emailsLoading = false;
    }
  };

  const handleAddEmail = async (): Promise<void> => {
    const email = addEmailValue.trim();
    if (!email) return;

    addEmailError = null;
    addEmailMessage = null;
    addEmailBusy = true;
    try {
      const response = await addAccountEmail({ email });

      if (response.developmentVerificationUrl) {
        const parsed = new URL(response.developmentVerificationUrl, window.location.origin);
        navigate(`${parsed.pathname}${parsed.search}`, { replace: false });
        return;
      }

      addEmailMessage = response.message;
      addEmailValue = "";
      await loadEmails();
    } catch (error) {
      addEmailError = toApiErrorShape(error);
    } finally {
      addEmailBusy = false;
    }
  };

  const handleMakePrimary = (emailId: string): void => {
    confirmMakePrimaryId = emailId;
  };

  const handleConfirmMakePrimary = async (): Promise<void> => {
    const emailId = confirmMakePrimaryId;
    if (!emailId) return;

    confirmMakePrimaryId = null;
    emailActionBusy = emailId;
    emailActionError = null;
    try {
      const response = await makeAccountEmailPrimary(emailId);
      emails = response.emails;
      // Re-bootstrap auth store so user.email reflects the new primary
      void authStore.bootstrap();
    } catch (error) {
      emailActionError = toApiErrorShape(error);
    } finally {
      emailActionBusy = null;
    }
  };

  const handleCancelMakePrimary = (): void => {
    confirmMakePrimaryId = null;
  };

  const handleRemoveEmail = (emailId: string): void => {
    confirmRemoveId = emailId;
  };

  const handleConfirmRemoveEmail = async (): Promise<void> => {
    const emailId = confirmRemoveId;
    if (!emailId) return;

    confirmRemoveId = null;
    emailActionBusy = emailId;
    emailActionError = null;
    try {
      const response = await removeAccountEmail(emailId);
      emails = response.emails;
    } catch (error) {
      emailActionError = toApiErrorShape(error);
    } finally {
      emailActionBusy = null;
    }
  };

  const handleCancelRemoveEmail = (): void => {
    confirmRemoveId = null;
  };

  const handleOpenEmailsOverlay = (): void => {
    emailsDialog.showModal();
  };

  const handleCloseEmailsOverlay = (): void => {
    addEmailValue = "";
    addEmailError = null;
    addEmailMessage = null;
    emailActionError = null;
    confirmMakePrimaryId = null;
    confirmRemoveId = null;
    emailsDialog.close();
  };

  const handleResendEmailVerification = async (emailId: string): Promise<void> => {
    emailActionBusy = emailId;
    emailActionError = null;
    try {
      const response = await resendAccountEmailVerification(emailId);

      if (response.developmentVerificationUrl) {
        const parsed = new URL(response.developmentVerificationUrl, window.location.origin);
        navigate(`${parsed.pathname}${parsed.search}`, { replace: false });
        return;
      }

      addEmailMessage = response.message;
    } catch (error) {
      emailActionError = toApiErrorShape(error);
    } finally {
      emailActionBusy = null;
    }
  };

  $: if (currentUserId && emailsLoadedForUserId !== currentUserId) {
    emailsLoadedForUserId = currentUserId;
    void loadEmails();
  }
  $: if (!currentUserId && emailsLoadedForUserId !== null) {
    emailsLoadedForUserId = null;
    emails = [];
  }

  onDestroy(() => {
    clearRedirectTimer();
    trackedThreadTabs.reset();
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
      title="Redirecting to sign in"
      message="You need to sign in before opening the account page."
    />
  {:else if currentUser}
    <div class="account-strip">
      <div class="account-identity">
        <div class="account-avatar" aria-hidden="true">{accountInitials}</div>
        <div class="account-identity-body">
          {#if isEditingDisplayName}
            <form class="display-name-form" on:submit|preventDefault={handleProfileSubmit}>
              <div class="display-name-field">
                <input
                  class="display-name-input"
                  name="displayName"
                  autocomplete="nickname"
                  bind:value={profileDisplayName}
                  maxlength="120"
                  placeholder="Optional display name"
                />
                <div class="display-name-actions">
                  <button type="submit" class="primary-button" disabled={isUpdatingProfile || !isProfileDirty}>
                    {isUpdatingProfile ? "Saving…" : "Save"}
                  </button>
                  <button type="button" class="secondary-button" on:click={cancelEditDisplayName}>
                    Cancel
                  </button>
                </div>
              </div>
              {#if profileError}
                <ErrorState
                  title="Unable to update profile"
                  message={profileError.message}
                  detail={formatErrorDetail(profileError)}
                />
              {/if}
            </form>
          {:else}
            <div class="account-name-row">
              <span class="account-name">{currentUserLabel}</span>
              <button type="button" class="edit-name-btn" on:click={() => { isEditingDisplayName = true; }}>
                Edit name
              </button>
            </div>
            {#if profileMessage}
              <p class="profile-saved-message" role="status">{profileMessage}</p>
            {/if}
            <div class="account-email-row">
              <span class="account-email">{currentUser.email}</span>
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
            </div>
          {/if}
        </div>
      </div>

      <div class="account-strip-right">
        {#if statusDescriptor && statusDescriptor.tone !== "neutral"}
          <p class:warning={statusDescriptor.tone === "warning"} class="status-pill">
            {statusDescriptor.label}
          </p>
        {/if}
        <div class="account-strip-actions">
          <button type="button" class="ghost-button" on:click={handleOpenEmailsOverlay}>
            Manage emails
          </button>
          <a
            href={forgotPasswordLink}
            class="ghost-link"
            on:click={(event) => onLinkClick(event, forgotPasswordLink)}
          >
            Reset password
          </a>
          <button
            type="button"
            class="primary-button"
            disabled={isLoggingOut}
            on:click={handleLogout}
          >
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>

    {#if logoutError}
      <ErrorState
        title="Unable to sign out"
        message={logoutError.message}
        detail={formatErrorDetail(logoutError)}
      />
    {/if}

    {#if currentUser.status === "pending_verification"}
      <div class="verification-notice" role="status">
        <p class="verification-notice-text">
          This account is still waiting on email verification.
        </p>
        <div class="verification-notice-actions">
          <button
            type="button"
            class="primary-button"
            disabled={isResending}
            on:click={handleResendVerification}
          >
            {isResending ? "Sending…" : "Resend verification email"}
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
      </div>
    {/if}

    <section class="tracked-threads-section" aria-label="Tracked threads">
      <h2 class="section-heading">Tracked Threads</h2>

      {#if trackedThreadCountsLoading}
        <LoadingState
          title="Loading tracked threads"
          message="Fetching tracked-thread counts and your first list."
        />
      {:else if trackedThreadCountsError}
        <ErrorState
          title="Unable to load tracked threads"
          message={trackedThreadCountsError.message}
          detail={formatErrorDetail(trackedThreadCountsError)}
        />
      {:else}
        <div class="tracked-thread-tabs" role="tablist" aria-label="Tracked thread lists">
          {#each TRACKED_THREAD_TABS as tab}
            <button
              type="button"
              id={"tracked-thread-tab-" + tab}
              role="tab"
              class="tracked-thread-tab"
              class:active={activeTrackedThreadTab === tab}
              aria-controls={"tracked-thread-panel-" + tab}
              aria-selected={activeTrackedThreadTab === tab}
              on:click={() => handleTrackedThreadTabSelect(tab)}
            >
              {getTrackedThreadTabLabel(tab, $trackedThreadTabsStore.tabs[tab].count)}
            </button>
          {/each}
        </div>

        <div
          id={"tracked-thread-panel-" + activeTrackedThreadTab}
          class="tracked-thread-tab-panel"
          role="tabpanel"
          aria-labelledby={"tracked-thread-tab-" + activeTrackedThreadTab}
        >
          <TrackedThreadList
            tab={activeTrackedThreadTab}
            items={activeTrackedThreadState.items}
            error={activeTrackedThreadState.error}
            loading={activeTrackedThreadState.loading}
            loadingMore={activeTrackedThreadState.loadingMore}
            nextCursor={activeTrackedThreadState.nextCursor}
            emptyMessage={getTrackedThreadEmptyMessage(activeTrackedThreadTab)}
            formatDateTime={formatDateTime}
            on:loadmore={(event) => handleTrackedThreadLoadMore(event.detail.tab)}
          />
        </div>
      {/if}
    </section>
    <dialog bind:this={emailsDialog} class="emails-overlay" aria-labelledby="emails-overlay-title">
      <header class="overlay-header">
        <h2 id="emails-overlay-title">Email addresses</h2>
        <button type="button" class="overlay-close" aria-label="Close" on:click={handleCloseEmailsOverlay}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>

      {#if emailActionError}
        <ErrorState
          title="Unable to update email"
          message={emailActionError.message}
          detail={formatErrorDetail(emailActionError)}
        />
      {/if}

      {#if emailsLoading}
        <p class="inline-status">Loading email addresses…</p>
      {:else if emailsError}
        <ErrorState
          title="Unable to load email addresses"
          message={emailsError.message}
          detail={formatErrorDetail(emailsError)}
        />
      {:else if emails.length > 0}
        <ul class="email-list">
          {#each emails as email (email.id)}
            <li class="email-item">
              <div class="email-item-info">
                <span class="email-address">{email.email}</span>
                <div class="email-badges">
                  {#if email.isPrimary}
                    <span class="badge badge-primary">Primary</span>
                  {/if}
                  {#if email.verifiedAt}
                    <button
                      type="button"
                      class="verification-indicator"
                      title="Verified since {formatDateTime(email.verifiedAt)}"
                      aria-label="Verified since {formatDateTime(email.verifiedAt)}"
                    >
                      <span class="verification-dot" aria-hidden="true"></span>
                      Verified
                    </button>
                  {:else}
                    <span class="badge badge-unverified">Unverified</span>
                  {/if}
                </div>
              </div>

              {#if confirmMakePrimaryId === email.id}
                <div class="confirm-panel">
                  <p class="confirm-message">
                    Make <strong>{email.email}</strong> your primary email? Password resets and account emails will go here.
                  </p>
                  <div class="actions">
                    <button
                      type="button"
                      class="primary-button"
                      disabled={emailActionBusy === email.id}
                      on:click={handleConfirmMakePrimary}
                    >
                      {emailActionBusy === email.id ? "Updating…" : "Yes, make primary"}
                    </button>
                    <button
                      type="button"
                      class="secondary-button"
                      on:click={handleCancelMakePrimary}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {:else if confirmRemoveId === email.id}
                <div class="confirm-panel">
                  <p class="confirm-message">
                    Remove <strong>{email.email}</strong> from your account? This cannot be undone.
                  </p>
                  <div class="actions">
                    <button
                      type="button"
                      class="danger-button"
                      disabled={emailActionBusy === email.id}
                      on:click={handleConfirmRemoveEmail}
                    >
                      {emailActionBusy === email.id ? "Removing…" : "Yes, remove"}
                    </button>
                    <button
                      type="button"
                      class="secondary-button"
                      on:click={handleCancelRemoveEmail}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {:else}
                <div class="email-item-actions">
                  {#if !email.isPrimary && email.verifiedAt}
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={emailActionBusy === email.id}
                      on:click={() => handleMakePrimary(email.id)}
                    >
                      Make primary
                    </button>
                  {/if}
                  {#if !email.isPrimary && !email.verifiedAt}
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={emailActionBusy === email.id}
                      on:click={() => handleResendEmailVerification(email.id)}
                    >
                      {emailActionBusy === email.id ? "Sending…" : "Resend verification"}
                    </button>
                  {/if}
                  {#if !email.isPrimary}
                    <button
                      type="button"
                      class="danger-button"
                      disabled={emailActionBusy === email.id}
                      on:click={() => handleRemoveEmail(email.id)}
                    >
                      Remove
                    </button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="overlay-add-section">
        {#if addEmailError}
          <ErrorState
            title="Unable to add email"
            message={addEmailError.message}
            detail={formatErrorDetail(addEmailError)}
          />
        {/if}

        {#if addEmailMessage}
          <SuccessState
            title="Request submitted"
            message={addEmailMessage}
          />
        {/if}

        <form on:submit|preventDefault={handleAddEmail}>
          <label class="field">
            <span>Add email address</span>
            <input
              type="email"
              name="email"
              autocomplete="email"
              bind:value={addEmailValue}
              placeholder="new@example.com"
              disabled={addEmailBusy}
            />
          </label>
          <div class="actions">
            <button
              type="submit"
              class="primary-button"
              disabled={addEmailBusy || addEmailValue.trim().length === 0}
            >
              {addEmailBusy ? "Sending…" : "Add and verify"}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  {/if}
</section>

<style>
  .account-page {
    display: grid;
    gap: 0.85rem;
    align-content: start;
    min-width: 0;
  }

  .page-title {
    margin: 0;
    color: #102a43;
    font-size: 1.45rem;
    line-height: 1.1;
  }

  .account-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border: 1px solid #d9e2ec;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 18px 34px -28px rgba(16, 42, 67, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.9);
    min-width: 0;
  }

  .account-identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    flex: 1;
  }

  .account-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.6rem;
    height: 2.6rem;
    border-radius: 999px;
    background: #0b4ea2;
    color: #fff;
    font-size: 0.88rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    user-select: none;
  }

  .account-identity-body {
    display: grid;
    gap: 0.22rem;
    min-width: 0;
  }

  .account-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .account-name {
    color: #102a43;
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.2;
    word-break: break-word;
  }

  .edit-name-btn {
    display: inline-flex;
    align-items: center;
    min-height: 1.35rem;
    padding: 0.12rem 0.5rem;
    border: 1px solid rgba(11, 78, 162, 0.22);
    border-radius: 999px;
    background: var(--primary-soft);
    color: var(--primary);
    font: inherit;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
  }

  .edit-name-btn:hover {
    background: #dcebff;
    border-color: rgba(11, 78, 162, 0.38);
  }

  .profile-saved-message {
    margin: 0;
    color: #1f6f43;
    font-size: 0.8rem;
    line-height: 1.3;
  }

  .account-email-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  .account-email {
    color: #486581;
    font-size: 0.88rem;
    line-height: 1.3;
    word-break: break-all;
  }

  .account-strip-right {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    align-items: center;
    flex-shrink: 0;
  }

  .account-strip-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .ghost-button,
  .ghost-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2rem;
    padding: 0.38rem 0.7rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.88);
    color: #486581;
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    font: inherit;
  }

  .ghost-button:hover,
  .ghost-link:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .display-name-form {
    display: grid;
    gap: 0.5rem;
  }

  .display-name-field {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .display-name-input {
    flex: 1;
    min-width: 10rem;
    min-height: 2.3rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid #bcccdc;
    border-radius: 0.8rem;
    background: rgba(255, 255, 255, 0.96);
    color: #102a43;
    font: inherit;
    font-size: 0.9rem;
  }

  .display-name-input::placeholder {
    color: #829ab1;
  }

  .display-name-actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }

  .verification-notice {
    display: grid;
    gap: 0.6rem;
    padding: 0.75rem 1rem;
    border: 1px solid #f2d58a;
    border-radius: 0.85rem;
    background: #fff7df;
  }

  .verification-notice-text {
    margin: 0;
    color: #8b6200;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .verification-notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .inline-status {
    margin: 0;
    color: #486581;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .verification-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
    min-height: 1.35rem;
    padding: 0.12rem 0.5rem;
    border: 1px solid #9fd5b3;
    border-radius: 999px;
    background: #eefbf1;
    color: #1f6f43;
    font: inherit;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1;
    cursor: help;
    white-space: nowrap;
  }

  .verification-dot {
    width: 0.44rem;
    height: 0.44rem;
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

  .status-pill.warning {
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

  .primary-button {
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
    cursor: default;
  }

  .primary-button:disabled:hover {
    background: #e8f2ff;
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

  .emails-overlay {
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    border: 1px solid #d9e2ec;
    border-radius: 1rem;
    padding: 0;
    background: #fff;
    box-shadow: 0 24px 48px -12px rgba(16, 42, 67, 0.28);
  }

  .emails-overlay[open] {
    display: grid;
    align-content: start;
  }

  .emails-overlay::backdrop {
    background: rgba(16, 42, 67, 0.38);
    backdrop-filter: blur(2px);
  }

  .overlay-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 1rem 1rem 0.75rem;
    border-bottom: 1px solid #edf2f7;
  }

  .overlay-header h2 {
    margin: 0;
    font-size: 1rem;
  }

  .overlay-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    background: transparent;
    color: #627d98;
    cursor: pointer;
    flex-shrink: 0;
    font: inherit;
  }

  .overlay-close:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .overlay-add-section {
    display: grid;
    gap: 0.65rem;
    padding: 0.85rem 1rem 1rem;
    border-top: 1px solid #edf2f7;
    margin-top: 0.15rem;
  }

  .overlay-add-section form {
    display: grid;
    gap: 0.65rem;
  }

  .email-list {
    list-style: none;
    margin: 0;
    padding: 0.85rem 1rem 0;
    display: grid;
    gap: 0.6rem;
  }

  .email-item {
    display: grid;
    gap: 0.5rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(248, 251, 255, 0.7);
  }

  .email-item-info {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }

  .email-address {
    color: #102a43;
    font-size: 0.93rem;
    font-weight: 600;
    word-break: break-all;
  }

  .email-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.74rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .badge-primary {
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .badge-unverified {
    border: 1px solid #f2d58a;
    background: #fff7df;
    color: #8b6200;
  }

  .email-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .confirm-panel {
    display: grid;
    gap: 0.55rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid #f2d58a;
    border-radius: 0.6rem;
    background: #fffbf0;
  }

  .confirm-message {
    margin: 0;
    color: #486581;
    font-size: 0.88rem;
    line-height: 1.45;
  }

  .secondary-button,
  .danger-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.1rem;
    padding: 0.38rem 0.7rem;
    border-radius: 999px;
    font-size: 0.83rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    font: inherit;
  }

  .secondary-button {
    border: 1px solid #d9e2ec;
    background: rgba(255, 255, 255, 0.88);
    color: #334e68;
  }

  .secondary-button:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .secondary-button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .danger-button {
    border: 1px solid #e7b4b8;
    background: #fff6f6;
    color: #7a1e21;
  }

  .danger-button:hover {
    background: #ffe8e8;
  }

  .danger-button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .tracked-threads-section {
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

  .tracked-thread-tabs {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .tracked-thread-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.35rem;
    padding: 0.48rem 0.85rem;
    border: 1px solid #d9e2ec;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.88);
    color: #486581;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }

  .tracked-thread-tab:hover {
    background: #f0f7ff;
    border-color: #9fb3c8;
    color: #243b53;
  }

  .tracked-thread-tab.active {
    border-color: #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .tracked-thread-tab-panel {
    display: grid;
    gap: 0.75rem;
    padding-top: 0.15rem;
  }

  @media (max-width: 640px) {
    .account-strip {
      flex-direction: column;
      align-items: stretch;
    }

    .account-strip-right {
      flex-direction: column;
      align-items: stretch;
    }

    .account-strip-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .ghost-button,
    .ghost-link,
    .primary-button {
      width: 100%;
      justify-content: center;
    }

    .tracked-thread-tab {
      width: 100%;
    }
  }
</style>
