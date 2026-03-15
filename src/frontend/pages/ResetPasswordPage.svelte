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
    loginPath,
    navigate,
    onLinkClick,
  } from "../router";

  const REDIRECT_DELAY_MS = 1000;

  let confirmPassword = "";
  let forgotLink = forgotPasswordPath;
  let loginLink = loginPath;
  let nextRedirect = homePath;
  let password = "";
  let redirectTimer: ReturnType<typeof setTimeout> | null = null;
  let resetError: ApiErrorShape | null = null;
  let status: "idle" | "success" | "missing-token" = "idle";
  let token = "";
  let validationMessage: string | null = null;

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
    forgotLink = buildAuthPath(forgotPasswordPath, nextRedirect);
    loginLink = buildAuthPath(loginPath, nextRedirect);

    if (nextToken.length === 0) {
      token = "";
      status = "missing-token";
      resetError = null;
      validationMessage = null;
      clearRedirectTimer();
      return;
    }

    if (nextToken !== token) {
      token = nextToken;
      status = "idle";
      resetError = null;
      validationMessage = null;
      clearRedirectTimer();
    }
  };

  const beginRedirect = (): void => {
    if (typeof window === "undefined") return;

    clearRedirectTimer();
    redirectTimer = window.setTimeout(() => {
      navigate(nextRedirect, { replace: true });
    }, REDIRECT_DELAY_MS);
  };

  const describeResetError = (
    error: ApiErrorShape
  ): { title: string; message: string } => {
    if (error.code === "TOKEN_EXPIRED") {
      return {
        title: "Reset link expired",
        message: "Request a new password reset email and use the most recent link.",
      };
    }

    if (error.code === "TOKEN_INVALID") {
      return {
        title: "Reset link invalid",
        message: "This password reset link is not valid anymore. Request another link to continue.",
      };
    }

    return {
      title: "Unable to reset password",
      message: error.message,
    };
  };

  const submitResetPassword = async (): Promise<void> => {
    if (!token) {
      status = "missing-token";
      return;
    }

    validationMessage = null;
    resetError = null;
    authStore.clearError();

    if (password !== confirmPassword) {
      validationMessage = "The password confirmation does not match.";
      return;
    }

    try {
      await authStore.resetPassword({
        newPassword: password,
        token,
      });

      status = "success";
      beginRedirect();
    } catch (error) {
      resetError = toApiErrorShape(error);
    }
  };

  $: if (typeof window !== "undefined") {
    $currentRoute;
    syncFromLocation();
  }

  $: isSubmitting = $authStore.currentAction === "reset-password";
  $: resetFailure = resetError ? describeResetError(resetError) : null;

  onDestroy(() => {
    clearRedirectTimer();
  });
</script>

<AuthPageLayout
  eyebrow="Reset access"
  title="Reset password"
  intro="Use the token from the email link to choose a new password. A successful reset signs you in and returns to a sanitized destination."
>
  {#if status === "success"}
    <SuccessState
      title="Password updated"
      message="Your password has been reset and you are now signed in."
      detail={nextRedirect}
    />

    <p class="helper-links">
      <a href={nextRedirect} on:click={(event) => onLinkClick(event, nextRedirect)}>Continue now</a>
    </p>
  {:else}
    {#if status === "missing-token"}
      <ErrorState
        title="Reset token missing"
        message="Open the full reset link from your email, or request a new one below."
      />
    {:else if resetFailure}
      <ErrorState
        title={resetFailure.title}
        message={resetFailure.message}
        detail={formatErrorDetail(resetError)}
      />
    {/if}

    {#if validationMessage}
      <p class="inline-note error">{validationMessage}</p>
    {/if}

    {#if isSubmitting}
      <LoadingState
        title="Resetting password"
        message="Updating the password and preparing the new session."
      />
    {/if}

    <form class="auth-form" on:submit|preventDefault={submitResetPassword}>
      <label class="field">
        <span>New password</span>
        <input
          type="password"
          name="newPassword"
          bind:value={password}
          autocomplete="new-password"
          placeholder="Enter a new password"
          required
          disabled={!token}
        />
      </label>

      <label class="field">
        <span>Confirm password</span>
        <input
          type="password"
          name="confirmPassword"
          bind:value={confirmPassword}
          autocomplete="new-password"
          placeholder="Repeat the new password"
          required
          disabled={!token}
        />
      </label>

      <div class="form-actions">
        <button type="submit" class="primary-button" disabled={isSubmitting || !token}>
          {isSubmitting ? "Resetting password..." : "Reset password"}
        </button>
      </div>
    </form>

    <p class="helper-links">
      <a href={forgotLink} on:click={(event) => onLinkClick(event, forgotLink)}
        >Need a new reset link?</a
      >
      <span aria-hidden="true">/</span>
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Back to login</a>
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

  .field input:disabled {
    background: #f4f7fb;
    color: #7b8794;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
  }

  .primary-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.65rem;
    padding: 0.58rem 0.95rem;
    border: 1px solid #6f9fdd;
    border-radius: 999px;
    background: #e8f2ff;
    color: #0b4ea2;
    font-size: 0.93rem;
    font-weight: 700;
    cursor: pointer;
  }

  .primary-button:hover {
    background: #dcebff;
  }

  .primary-button:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .helper-links {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
    color: #486581;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .helper-links a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
  }

  .inline-note {
    margin: 0;
    padding: 0.72rem 0.82rem;
    border-radius: 0.75rem;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .inline-note.error {
    border: 1px solid #e7b4b8;
    background: #fff6f6;
    color: #7a1e21;
  }

  @media (max-width: 640px) {
    .form-actions,
    .primary-button {
      width: 100%;
    }
  }
</style>
