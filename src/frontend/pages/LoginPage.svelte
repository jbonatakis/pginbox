<script lang="ts">
  import { onDestroy } from "svelte";
  import AuthPageLayout from "../components/auth/AuthPageLayout.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import SuccessState from "../components/SuccessState.svelte";
  import {
    buildAuthPath,
    getSanitizedNextRedirect,
  } from "../lib/authRedirect";
  import { toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { authStore } from "../lib/state/auth";
  import {
    currentRoute,
    forgotPasswordPath,
    homePath,
    navigate,
    onLinkClick,
    registerPath,
  } from "../router";

  const REDIRECT_DELAY_MS = 900;

  let email = "";
  let forgotLink = forgotPasswordPath;
  let nextRedirect = homePath;
  let password = "";
  let redirectTimer: ReturnType<typeof setTimeout> | null = null;
  let registerLink = registerPath;
  let resendError: ApiErrorShape | null = null;
  let resendMessage: string | null = null;
  let submitError: ApiErrorShape | null = null;
  let status: "idle" | "success" = "idle";

  const clearRedirectTimer = (): void => {
    if (redirectTimer === null) return;
    clearTimeout(redirectTimer);
    redirectTimer = null;
  };

  const formatErrorDetail = (error: ApiErrorShape | null): string | null => {
    if (!error) return null;

    if (error.status > 0) {
      return `${error.method} ${error.path || "/api"} -> ${error.status}`;
    }

    return `${error.method} ${error.path || "/api"} -> ${error.code ?? "NETWORK_ERROR"}`;
  };

  const syncQueryState = (): void => {
    if (typeof window === "undefined") return;

    nextRedirect = getSanitizedNextRedirect(window.location.search, homePath);
    forgotLink = buildAuthPath(forgotPasswordPath, nextRedirect);
    registerLink = buildAuthPath(registerPath, nextRedirect);
  };

  const beginRedirect = (): void => {
    if (typeof window === "undefined") return;

    clearRedirectTimer();
    redirectTimer = window.setTimeout(() => {
      navigate(nextRedirect, { replace: true });
    }, REDIRECT_DELAY_MS);
  };

  const describeLoginError = (
    error: ApiErrorShape
  ): { title: string; message: string } => {
    if (error.code === "INVALID_CREDENTIALS") {
      return {
        title: "Invalid credentials",
        message: "Check the email address and password, then try again.",
      };
    }

    if (error.code === "EMAIL_NOT_VERIFIED") {
      return {
        title: "Email verification required",
        message: "Open the verification email for this account or request a fresh link below.",
      };
    }

    if (error.code === "ACCOUNT_DISABLED") {
      return {
        title: "Account disabled",
        message: "This account is disabled and cannot sign in.",
      };
    }

    if (error.code === "RATE_LIMITED") {
      return {
        title: "Too many attempts",
        message: error.message,
      };
    }

    return {
      title: "Unable to sign in",
      message: error.message,
    };
  };

  const submitLogin = async (): Promise<void> => {
    clearRedirectTimer();
    resendError = null;
    resendMessage = null;
    status = "idle";
    submitError = null;
    authStore.clearError();

    try {
      await authStore.login({
        email: email.trim(),
        password,
      });

      status = "success";
      beginRedirect();
    } catch (error) {
      submitError = toApiErrorShape(error);
    }
  };

  const resendVerification = async (): Promise<void> => {
    resendError = null;
    resendMessage = null;

    try {
      const response = await authStore.resendVerification({ email: email.trim() });
      resendMessage = response.message;
    } catch (error) {
      resendError = toApiErrorShape(error);
    }
  };

  $: if (typeof window !== "undefined") {
    $currentRoute;
    syncQueryState();
  }

  $: currentUserLabel =
    $authStore.user?.displayName?.trim() || $authStore.user?.email || "your account";
  $: isResending = $authStore.currentAction === "resend-verification";
  $: isSubmitting = $authStore.currentAction === "login";
  $: loginError = submitError ? describeLoginError(submitError) : null;
  $: requiresVerification = submitError?.code === "EMAIL_NOT_VERIFIED";

  onDestroy(() => {
    clearRedirectTimer();
  });
</script>

<AuthPageLayout
  eyebrow="Account access"
  title="Log in"
  intro="Sign in when you need account features or to return cleanly after auth flows. Archive browsing stays open either way."
>
  {#if $authStore.isAuthenticated}
    <SuccessState
      title="Already signed in"
      message={`You are signed in as ${currentUserLabel}.`}
      detail={$authStore.user?.status === "pending_verification" ? "Email verification still pending." : null}
    />

    <p class="action-row">
      <a href={nextRedirect} class="primary-link" on:click={(event) => onLinkClick(event, nextRedirect)}
        >Continue</a
      >
    </p>
  {:else if status === "success"}
    <SuccessState
      title="Signed in"
      message="Your session is ready. Redirecting now."
      detail={nextRedirect}
    />

    <p class="action-row">
      <a href={nextRedirect} class="primary-link" on:click={(event) => onLinkClick(event, nextRedirect)}
        >Continue now</a
      >
    </p>
  {:else}
    {#if loginError}
      <ErrorState
        title={loginError.title}
        message={loginError.message}
        detail={formatErrorDetail(submitError)}
      />
    {/if}

    {#if isSubmitting}
      <LoadingState
        title="Signing in"
        message="Checking your credentials and starting the session."
      />
    {/if}

    <form class="auth-form" on:submit|preventDefault={submitLogin}>
      <label class="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          bind:value={email}
          autocomplete="email"
          placeholder="you@example.com"
          required
        />
      </label>

      <label class="field">
        <span>Password</span>
        <input
          type="password"
          name="password"
          bind:value={password}
          autocomplete="current-password"
          placeholder="Enter your password"
          required
        />
      </label>

      <div class="form-actions">
        <button type="submit" class="primary-button" disabled={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Log in"}
        </button>
      </div>
    </form>

    {#if requiresVerification}
      <section class="support-panel">
        <div class="support-copy">
          <h2>Need another verification email?</h2>
          <p>Send a fresh link to the same address if this account is still waiting for verification.</p>
        </div>

        <button
          type="button"
          class="secondary-button"
          disabled={isResending || email.trim().length === 0}
          on:click={resendVerification}>{
          isResending ? "Sending..." : "Send verification email"
        }</button>

        {#if resendMessage}
          <p class="inline-note success">{resendMessage}</p>
        {/if}

        {#if resendError}
          <p class="inline-note error">{describeLoginError(resendError).message}</p>
        {/if}
      </section>
    {/if}

    <p class="helper-links">
      <a href={forgotLink} on:click={(event) => onLinkClick(event, forgotLink)}>Forgot password?</a>
      <span aria-hidden="true">/</span>
      <a href={registerLink} on:click={(event) => onLinkClick(event, registerLink)}
        >Create an account</a
      >
    </p>
  {/if}
</AuthPageLayout>

<style>
  .auth-form {
    display: grid;
    gap: 0.9rem;
  }

  .field {
    display: grid;
    gap: 0.38rem;
  }

  .field span {
    color: #243b53;
    font-size: 0.9rem;
    font-weight: 700;
  }

  .field input {
    width: 100%;
    min-height: 2.9rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid #c5d0da;
    border-radius: 0.8rem;
    background: rgba(255, 255, 255, 0.96);
    color: #102a43;
    font-size: 1rem;
  }

  .field input::placeholder {
    color: #7b8794;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
    align-items: center;
  }

  .primary-button,
  .secondary-button,
  .primary-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.65rem;
    padding: 0.58rem 0.95rem;
    border-radius: 999px;
    font-size: 0.93rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
  }

  .primary-button,
  .primary-link {
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .secondary-button {
    border: 1px solid #c5d0da;
    background: rgba(255, 255, 255, 0.92);
    color: #243b53;
  }

  .primary-button:hover,
  .primary-link:hover {
    background: #dcebff;
  }

  .secondary-button:hover {
    background: #f5f8fb;
  }

  .primary-button:disabled,
  .secondary-button:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .support-panel {
    display: grid;
    gap: 0.7rem;
    padding: 0.95rem;
    border: 1px solid #d9e2ec;
    border-radius: 0.9rem;
    background: rgba(245, 249, 255, 0.82);
  }

  .support-copy {
    display: grid;
    gap: 0.18rem;
  }

  .support-copy h2 {
    margin: 0;
    color: #102a43;
    font-size: 1rem;
  }

  .support-copy p,
  .helper-links {
    margin: 0;
    color: #486581;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .helper-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }

  .helper-links a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
  }

  .action-row {
    margin: 0;
  }

  .inline-note {
    margin: 0;
    padding: 0.72rem 0.82rem;
    border-radius: 0.75rem;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .inline-note.success {
    border: 1px solid #a8d5b8;
    background: #f5fcf7;
    color: #24563b;
  }

  .inline-note.error {
    border: 1px solid #e7b4b8;
    background: #fff6f6;
    color: #7a1e21;
  }

  @media (max-width: 640px) {
    .form-actions {
      align-items: stretch;
    }

    .primary-button,
    .secondary-button,
    .primary-link {
      width: 100%;
    }

    .helper-links {
      gap: 0.3rem;
    }
  }
</style>
