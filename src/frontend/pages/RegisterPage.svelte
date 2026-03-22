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
    navigate,
    onLinkClick,
  } from "../router";

  let displayName = "";
  let email = "";
  let loginLink = loginPath;
  let nextRedirect = homePath;
  let password = "";
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
  };

  const describeRegisterError = (
    error: ApiErrorShape
  ): { title: string; message: string } => {
    if (error.code === "RATE_LIMITED") {
      return {
        title: "Too many registration attempts",
        message: error.message,
      };
    }

    return {
      title: "Unable to register",
      message: error.message,
    };
  };

  const submitRegistration = async (): Promise<void> => {
    authStore.clearError();
    status = "idle";
    submitError = null;
    successMessage = null;

    try {
      const response = await authStore.register({
        displayName: displayName.trim() || null,
        email: email.trim(),
        password,
      });

      if (typeof window !== "undefined" && response.developmentVerificationUrl) {
        const parsed = new URL(response.developmentVerificationUrl, window.location.origin);
        navigate(buildAuthPath(`${parsed.pathname}${parsed.search}${parsed.hash}`, nextRedirect), {
          replace: true,
        });
        return;
      }

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

  $: currentUserLabel =
    $authStore.user?.displayName?.trim() || $authStore.user?.email || "your account";
  $: isSubmitting = $authStore.currentAction === "register";
  $: registerError = submitError ? describeRegisterError(submitError) : null;
</script>

<AuthPageLayout
  eyebrow="New account"
  title="Register"
  intro="Create an account for sign-in flows without changing how the archive itself is browsed."
>
  {#if $authStore.isAuthenticated}
    <SuccessState
      title="Already signed in"
      message={`You are signed in as ${currentUserLabel}.`}
    />

    <p class="helper-links">
      <a href={nextRedirect} on:click={(event) => onLinkClick(event, nextRedirect)}>Continue browsing</a>
    </p>
  {:else if status === "success" && successMessage}
    <SuccessState title="Check your email" message={successMessage} detail={email.trim() || null} />

    <p class="support-copy">
      Open the verification email, activate the account, then sign in when you are ready.
    </p>

    <p class="helper-links">
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Already verified? Sign in</a>
    </p>
  {:else}
    {#if registerError}
      <ErrorState
        title={registerError.title}
        message={registerError.message}
        detail={formatErrorDetail(submitError)}
      />
    {/if}

    {#if isSubmitting}
      <LoadingState
        title="Creating account"
        message="Submitting registration details and preparing the verification email."
      />
    {/if}

    <form class="auth-form" on:submit|preventDefault={submitRegistration}>
      <label class="field">
        <span>Display name</span>
        <input
          type="text"
          name="displayName"
          bind:value={displayName}
          autocomplete="name"
          placeholder="Optional"
        />
      </label>

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
          autocomplete="new-password"
          placeholder="Choose a password"
          required
        />
      </label>

      <div class="form-actions">
        <button type="submit" class="primary-button" disabled={isSubmitting}>
          {isSubmitting ? "Creating account..." : "Create account"}
        </button>
      </div>
    </form>

    <p class="helper-links">
      <a href={loginLink} on:click={(event) => onLinkClick(event, loginLink)}>Already have an account? Sign in</a>
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
