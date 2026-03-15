<script lang="ts">
  import AuthPageLayout from "../components/auth/AuthPageLayout.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import SuccessState from "../components/SuccessState.svelte";
  import { buildAuthPath, getSanitizedNextRedirect } from "../lib/authRedirect";
  import { toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { authStore } from "../lib/state/auth";
  import {
    currentRoute,
    homePath,
    loginPath,
    onLinkClick,
    registerPath,
  } from "../router";

  let email = "";
  let loginLink = loginPath;
  let nextRedirect = homePath;
  let registerLink = registerPath;
  let submitError: ApiErrorShape | null = null;
  let successMessage: string | null = null;
  let status: "idle" | "success" = "idle";

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
    loginLink = buildAuthPath(loginPath, nextRedirect);
    registerLink = buildAuthPath(registerPath, nextRedirect);
  };

  const describeForgotError = (
    error: ApiErrorShape
  ): { title: string; message: string } => {
    if (error.code === "RATE_LIMITED") {
      return {
        title: "Too many reset requests",
        message: error.message,
      };
    }

    return {
      title: "Unable to send reset instructions",
      message: error.message,
    };
  };

  const submitForgotPassword = async (): Promise<void> => {
    authStore.clearError();
    status = "idle";
    submitError = null;
    successMessage = null;

    try {
      const response = await authStore.forgotPassword({ email: email.trim() });
      status = "success";
      successMessage = response.message;
    } catch (error) {
      submitError = toApiErrorShape(error);
    }
  };

  $: if (typeof window !== "undefined") {
    $currentRoute;
    syncQueryState();
  }

  $: isSubmitting = $authStore.currentAction === "forgot-password";
  $: forgotError = submitError ? describeForgotError(submitError) : null;
</script>

<AuthPageLayout
  eyebrow="Password help"
  title="Forgot password"
  intro="Request a password reset email. If the account exists, the message goes out without exposing whether the address is registered."
>
  {#if status === "success" && successMessage}
    <SuccessState title="Check your email" message={successMessage} detail={email.trim() || null} />

    <p class="support-copy">
      Use the newest reset link you receive. Completing the reset signs you into that account.
    </p>

    <p class="helper-links">
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Back to login</a>
    </p>
  {:else}
    {#if forgotError}
      <ErrorState
        title={forgotError.title}
        message={forgotError.message}
        detail={formatErrorDetail(submitError)}
      />
    {/if}

    {#if isSubmitting}
      <LoadingState
        title="Sending reset email"
        message="Submitting the request and preparing password reset instructions."
      />
    {/if}

    <form class="auth-form" on:submit|preventDefault={submitForgotPassword}>
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

      <div class="form-actions">
        <button type="submit" class="primary-button" disabled={isSubmitting}>
          {isSubmitting ? "Sending reset email..." : "Send reset email"}
        </button>
      </div>
    </form>

    <p class="helper-links">
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Remembered it? Log in</a>
      <span aria-hidden="true">/</span>
      <a href={registerLink} on:click={(event) => onLinkClick(event, registerLink)}
        >Need an account instead?</a
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
    cursor: wait;
  }

  .helper-links,
  .support-copy {
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

  @media (max-width: 640px) {
    .form-actions,
    .primary-button {
      width: 100%;
    }
  }
</style>
