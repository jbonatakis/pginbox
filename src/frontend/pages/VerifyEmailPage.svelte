<script lang="ts">
  import { onDestroy } from "svelte";
  import AuthPageLayout from "../components/auth/AuthPageLayout.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import SuccessState from "../components/SuccessState.svelte";
  import { buildAuthPath, getSanitizedNextRedirect } from "../lib/authRedirect";
  import { toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { authStore } from "../lib/state/auth";
  import {
    accountPath,
    currentRoute,
    homePath,
    loginPath,
    navigate,
    onLinkClick,
    registerPath,
  } from "../router";

  const REDIRECT_DELAY_MS = 1000;

  let hasSeededResendEmail = false;
  let lastAttemptedToken: string | null = null;
  let loginLink = loginPath;
  let nextRedirect = homePath;
  let pageStatus: "loading" | "success" | "secondary-success" | "error" | "missing-token" = "loading";
  let redirectTimer: number | null = null;
  let registerLink = registerPath;
  let resendEmail = "";
  let resendError: ApiErrorShape | null = null;
  let resendMessage: string | null = null;
  let token = "";
  let verificationError: ApiErrorShape | null = null;

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

  const syncFromLocation = (): void => {
    if (typeof window === "undefined") return;

    const search = window.location.search;
    const searchParams = new URLSearchParams(search);
    const nextToken = searchParams.get("token")?.trim() ?? "";

    nextRedirect = getSanitizedNextRedirect(search, homePath);
    loginLink = buildAuthPath(loginPath, nextRedirect);
    registerLink = buildAuthPath(registerPath, nextRedirect);

    if (nextToken.length === 0) {
      token = "";
      lastAttemptedToken = null;
      verificationError = null;
      pageStatus = "missing-token";
      clearRedirectTimer();
      return;
    }

    const tokenChanged = nextToken !== token;
    token = nextToken;

    if (tokenChanged) {
      clearRedirectTimer();
      resendError = null;
      resendMessage = null;
      verificationError = null;
    }

    if (token !== lastAttemptedToken) {
      lastAttemptedToken = token;
      void verifyCurrentToken(token);
    }
  };

  const beginRedirect = (): void => {
    if (typeof window === "undefined") return;

    clearRedirectTimer();
    redirectTimer = window.setTimeout(() => {
      navigate(nextRedirect, { replace: true });
    }, REDIRECT_DELAY_MS);
  };

  const describeVerifyError = (
    error: ApiErrorShape
  ): { title: string; message: string } => {
    if (error.code === "TOKEN_EXPIRED") {
      return {
        title: "Verification link expired",
        message: "Request a new verification email and open the latest link.",
      };
    }

    if (error.code === "TOKEN_INVALID") {
      return {
        title: "Verification link invalid",
        message: "This verification link is not valid anymore. Request a fresh email to continue.",
      };
    }

    return {
      title: "Unable to verify email",
      message: error.message,
    };
  };

  const verifyCurrentToken = async (value: string): Promise<void> => {
    authStore.clearError();
    pageStatus = "loading";
    verificationError = null;

    try {
      const response = await authStore.verifyEmail({ token: value });
      if (response.isRegistration) {
        pageStatus = "success";
        beginRedirect();
      } else {
        pageStatus = "secondary-success";
      }
    } catch (error) {
      verificationError = toApiErrorShape(error);
      pageStatus = "error";
    }
  };

  const retryVerification = (): void => {
    if (!token) return;
    lastAttemptedToken = token;
    void verifyCurrentToken(token);
  };

  const resendVerification = async (): Promise<void> => {
    resendError = null;
    resendMessage = null;

    try {
      const response = await authStore.resendVerification({ email: resendEmail.trim() });

      if (typeof window !== "undefined" && response.developmentVerificationUrl) {
        const parsed = new URL(response.developmentVerificationUrl, window.location.origin);
        navigate(buildAuthPath(`${parsed.pathname}${parsed.search}${parsed.hash}`, nextRedirect), {
          replace: true,
        });
        return;
      }

      resendMessage = response.message;
    } catch (error) {
      resendError = toApiErrorShape(error);
    }
  };

  $: if (typeof window !== "undefined") {
    $currentRoute;
    syncFromLocation();
  }

  $: if (!hasSeededResendEmail && $authStore.user?.email) {
    resendEmail = $authStore.user.email;
    hasSeededResendEmail = true;
  }

  $: isResending = $authStore.currentAction === "resend-verification";
  $: verifyError = verificationError ? describeVerifyError(verificationError) : null;

  onDestroy(() => {
    clearRedirectTimer();
  });
</script>

<AuthPageLayout
  eyebrow="Verification"
  title="Verify email"
>
  {#if pageStatus === "loading"}
    <LoadingState
      title="Verifying email"
      message="Checking the verification link and preparing your session."
    />
  {:else if pageStatus === "success"}
    <SuccessState
      title="Email verified"
      message="The account is active and your session is ready."
      detail={nextRedirect}
    />
    <div class="page-actions">
      <a href={nextRedirect} class="primary-button" on:click={(event) => onLinkClick(event, nextRedirect)}>Continue</a>
    </div>
  {:else if pageStatus === "secondary-success"}
    <SuccessState
      title="Email verified"
      message="Your email address has been verified and added to your account."
    />
    <div class="page-actions">
      <a href={accountPath} class="primary-button" on:click={(event) => onLinkClick(event, accountPath)}>Go to account settings</a>
    </div>
  {:else}
    <div class="error-group">
      {#if pageStatus === "missing-token"}
        <ErrorState
          title="Verification token missing"
          message="Open the full verification link from your email, or request a new one below."
        />
      {:else if verifyError}
        <ErrorState
          title={verifyError.title}
          message={verifyError.message}
          detail={formatErrorDetail(verificationError)}
        />
      {/if}

      {#if token}
        <div class="page-actions">
          <button type="button" class="secondary-button" on:click={retryVerification}>
            Retry verification
          </button>
        </div>
      {/if}
    </div>

    <section class="support-panel">
      <div class="support-copy">
        <h2>Need another verification email?</h2>
        <p>Enter your account email and we'll send a new verification link if the account is still pending.</p>
      </div>

      <label class="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          bind:value={resendEmail}
          autocomplete="email"
          placeholder="you@example.com"
          required
        />
      </label>

      <div class="form-actions">
        <button
          type="button"
          class="primary-button"
          disabled={isResending || resendEmail.trim().length === 0}
          on:click={resendVerification}
        >{isResending ? "Sending..." : "Send verification email"}</button>
      </div>

      {#if resendMessage}
        <p class="inline-note success">{resendMessage}</p>
      {/if}

      {#if resendError}
        <p class="inline-note error">{describeVerifyError(resendError).message}</p>
      {/if}
    </section>

    <p class="helper-links">
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Sign in</a>
      <span aria-hidden="true">/</span>
      <a href={registerLink} on:click={(event) => onLinkClick(event, registerLink)}>Create an account</a>
    </p>
  {/if}
</AuthPageLayout>

<style>
  .page-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
  }

  .error-group {
    display: grid;
    gap: 0.65rem;
  }

  .support-panel {
    display: grid;
    gap: 0.75rem;
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
  }

  .primary-button,
  .secondary-button {
    font: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0.52rem 0.95rem;
    border-radius: 999px;
    font-size: 0.93rem;
    font-weight: 700;
    line-height: 1;
    text-decoration: none;
    cursor: pointer;
  }

  .primary-button {
    border: 1px solid #6f9fdd;
    background: #e8f2ff;
    color: #0b4ea2;
  }

  .secondary-button {
    border: 1px solid #c5d0da;
    background: rgba(255, 255, 255, 0.92);
    color: #243b53;
  }

  .primary-button:hover {
    background: #dcebff;
  }

  .secondary-button:hover {
    background: #f5f8fb;
  }

  .primary-button:disabled {
    opacity: 0.7;
    cursor: wait;
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
    .form-actions,
    .form-actions .primary-button,
    .secondary-button {
      width: 100%;
    }
  }
</style>
