import type {
  AccountProfileUpdateRequest,
  AccountProfileUpdateResponse,
  AuthForgotPasswordRequest,
  AuthForgotPasswordResponse,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthMeResponse,
  AuthRegisterRequest,
  AuthRegisterResponse,
  AuthResendVerificationRequest,
  AuthResendVerificationResponse,
  AuthResetPasswordRequest,
  AuthResetPasswordResponse,
  AuthUser,
  AuthVerifyEmailRequest,
  AuthVerifyEmailResponse,
} from "shared/api";
import { writable, type Readable } from "svelte/store";
import {
  forgotPassword as forgotPasswordRequest,
  getAuthMe,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  resendVerification as resendVerificationRequest,
  resetPassword as resetPasswordRequest,
  toApiErrorShape,
  updateAccountProfile as updateAccountProfileRequest,
  verifyEmail as verifyEmailRequest,
  type ApiErrorShape,
} from "../api";

export type AuthBootstrapStatus = "idle" | "loading" | "ready" | "error";
export type AuthAction =
  | "forgot-password"
  | "login"
  | "logout"
  | "register"
  | "resend-verification"
  | "reset-password"
  | "update-profile"
  | "verify-email";

interface AuthStateShape {
  bootstrapStatus: AuthBootstrapStatus;
  currentAction: AuthAction | null;
  error: ApiErrorShape | null;
  user: AuthUser | null;
}

export interface AuthState extends AuthStateShape {
  isAuthenticated: boolean;
  isBootstrapped: boolean;
  isBootstrapping: boolean;
  isLoading: boolean;
}

export interface AuthStore extends Readable<AuthState> {
  bootstrap(): Promise<AuthMeResponse>;
  clearError(): void;
  forgotPassword(input: AuthForgotPasswordRequest): Promise<AuthForgotPasswordResponse>;
  login(input: AuthLoginRequest): Promise<AuthLoginResponse>;
  logout(): Promise<void>;
  register(input: AuthRegisterRequest): Promise<AuthRegisterResponse>;
  resendVerification(
    input: AuthResendVerificationRequest
  ): Promise<AuthResendVerificationResponse>;
  resetPassword(input: AuthResetPasswordRequest): Promise<AuthResetPasswordResponse>;
  setUser(user: AuthUser | null): void;
  updateProfile(input: AccountProfileUpdateRequest): Promise<AccountProfileUpdateResponse>;
  verifyEmail(input: AuthVerifyEmailRequest): Promise<AuthVerifyEmailResponse>;
}

const INITIAL_AUTH_STATE_SHAPE: AuthStateShape = {
  bootstrapStatus: "idle",
  currentAction: null,
  error: null,
  user: null,
};

type AuthStateUpdater = (current: AuthStateShape) => AuthStateShape;

function toAuthState(state: AuthStateShape): AuthState {
  const isBootstrapping = state.bootstrapStatus === "loading";

  return {
    ...state,
    isAuthenticated: state.user !== null,
    isBootstrapped: state.bootstrapStatus === "ready",
    isBootstrapping,
    isLoading: isBootstrapping || state.currentAction !== null,
  };
}

export function createAuthStore(): AuthStore {
  const store = writable<AuthState>(toAuthState(INITIAL_AUTH_STATE_SHAPE));
  let state = INITIAL_AUTH_STATE_SHAPE;
  let actionRequestId = 0;
  let bootstrapPromise: Promise<AuthMeResponse> | null = null;
  let sessionVersion = 0;

  const setState = (next: AuthStateShape | AuthStateUpdater): void => {
    const resolved = typeof next === "function" ? next(state) : next;
    state = resolved;
    store.set(toAuthState(resolved));
  };

  const startAction = (action: AuthAction): number => {
    const requestId = actionRequestId + 1;
    actionRequestId = requestId;
    setState((current) => ({
      ...current,
      currentAction: action,
      error: null,
    }));
    return requestId;
  };

  const finishAction = (requestId: number, updater: AuthStateUpdater): void => {
    if (requestId !== actionRequestId) return;
    setState(updater);
  };

  const failAction = (requestId: number, error: unknown): void => {
    if (requestId !== actionRequestId) return;
    setState((current) => ({
      ...current,
      currentAction: null,
      error: toApiErrorShape(error),
    }));
  };

  const completeSessionUpdate = (requestId: number, user: AuthUser | null): void => {
    if (requestId !== actionRequestId) return;
    sessionVersion += 1;
    setState((current) => ({
      ...current,
      bootstrapStatus: "ready",
      currentAction: null,
      error: null,
      user,
    }));
  };

  const completeUserUpdate = (requestId: number, user: AuthUser): void => {
    if (requestId !== actionRequestId) return;
    sessionVersion += 1;
    setState((current) => ({
      ...current,
      bootstrapStatus: "ready",
      currentAction: null,
      error: null,
      user,
    }));
  };

  const runAction = async <T>(
    action: AuthAction,
    request: () => Promise<T>,
    onSuccess: (result: T, requestId: number) => void
  ): Promise<T> => {
    const requestId = startAction(action);

    try {
      const result = await request();
      onSuccess(result, requestId);
      return result;
    } catch (error) {
      failAction(requestId, error);
      throw error;
    }
  };

  return {
    subscribe: store.subscribe,

    async bootstrap(): Promise<AuthMeResponse> {
      if (bootstrapPromise) return bootstrapPromise;

      if (state.bootstrapStatus === "ready") {
        return { user: state.user };
      }

      const bootstrapSessionVersion = sessionVersion;
      setState((current) => ({
        ...current,
        bootstrapStatus: "loading",
        error: current.currentAction === null ? null : current.error,
      }));

      let request: Promise<AuthMeResponse>;
      request = getAuthMe()
        .then((response) => {
          if (bootstrapSessionVersion !== sessionVersion) return response;

          setState((current) => ({
            ...current,
            bootstrapStatus: "ready",
            error: current.currentAction === null ? null : current.error,
            user: response.user,
          }));

          return response;
        })
        .catch((error) => {
          if (bootstrapSessionVersion === sessionVersion) {
            setState((current) => ({
              ...current,
              bootstrapStatus: "error",
              error: current.currentAction === null ? toApiErrorShape(error) : current.error,
            }));
          }

          throw error;
        })
        .finally(() => {
          if (bootstrapPromise === request) {
            bootstrapPromise = null;
          }
        });

      bootstrapPromise = request;
      return request;
    },

    clearError(): void {
      setState((current) => ({ ...current, error: null }));
    },

    async register(input: AuthRegisterRequest): Promise<AuthRegisterResponse> {
      return runAction("register", () => registerRequest(input), (_response, requestId) => {
        finishAction(requestId, (current) => ({
          ...current,
          currentAction: null,
          error: null,
        }));
      });
    },

    async resendVerification(
      input: AuthResendVerificationRequest
    ): Promise<AuthResendVerificationResponse> {
      return runAction(
        "resend-verification",
        () => resendVerificationRequest(input),
        (_response, requestId) => {
          finishAction(requestId, (current) => ({
            ...current,
            currentAction: null,
            error: null,
          }));
        }
      );
    },

    async verifyEmail(input: AuthVerifyEmailRequest): Promise<AuthVerifyEmailResponse> {
      return runAction("verify-email", () => verifyEmailRequest(input), (response, requestId) => {
        completeSessionUpdate(requestId, response.user);
      });
    },

    async login(input: AuthLoginRequest): Promise<AuthLoginResponse> {
      return runAction("login", () => loginRequest(input), (response, requestId) => {
        completeSessionUpdate(requestId, response.user);
      });
    },

    async logout(): Promise<void> {
      return runAction("logout", () => logoutRequest(), (_response, requestId) => {
        completeSessionUpdate(requestId, null);
      });
    },

    async forgotPassword(input: AuthForgotPasswordRequest): Promise<AuthForgotPasswordResponse> {
      return runAction("forgot-password", () => forgotPasswordRequest(input), (_response, requestId) => {
        finishAction(requestId, (current) => ({
          ...current,
          currentAction: null,
          error: null,
        }));
      });
    },

    async resetPassword(input: AuthResetPasswordRequest): Promise<AuthResetPasswordResponse> {
      return runAction("reset-password", () => resetPasswordRequest(input), (response, requestId) => {
        completeSessionUpdate(requestId, response.user);
      });
    },

    async updateProfile(input: AccountProfileUpdateRequest): Promise<AccountProfileUpdateResponse> {
      return runAction(
        "update-profile",
        () => updateAccountProfileRequest(input),
        (response, requestId) => {
          completeUserUpdate(requestId, response.user);
        }
      );
    },

    setUser(user: AuthUser | null): void {
      sessionVersion += 1;
      setState((current) => ({
        ...current,
        bootstrapStatus: "ready",
        currentAction: null,
        error: null,
        user,
      }));
    },
  };
}

export const authStore = createAuthStore();
