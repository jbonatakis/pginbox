import {
  resolveAuthEmailRuntimeConfig,
  type AuthEmailRuntimeConfig,
} from "./config";

export interface VerificationEmailDelivery {
  displayName: string | null;
  email: string;
  expiresAt: Date;
  verificationUrl: string;
}

export interface PasswordResetEmailDelivery {
  displayName: string | null;
  email: string;
  expiresAt: Date;
  resetUrl: string;
}

export interface AuthEmailSender {
  sendVerificationEmail(payload: VerificationEmailDelivery): Promise<void>;
  sendPasswordResetEmail(payload: PasswordResetEmailDelivery): Promise<void>;
}

interface InfoLogger {
  info(message?: unknown, ...optionalParams: unknown[]): void;
}

export function createDevelopmentAuthEmailSender(logger: InfoLogger = console): AuthEmailSender {
  return {
    async sendVerificationEmail(payload) {
      logger.info(
        `[auth:dev-mail] verification email for ${payload.email} (${payload.expiresAt.toISOString()}): ${payload.verificationUrl}`
      );
    },

    async sendPasswordResetEmail(payload) {
      logger.info(
        `[auth:dev-mail] password reset email for ${payload.email} (${payload.expiresAt.toISOString()}): ${payload.resetUrl}`
      );
    },
  };
}

export function createAuthEmailSender(
  logger: InfoLogger = console,
  config: AuthEmailRuntimeConfig = resolveAuthEmailRuntimeConfig(),
): AuthEmailSender {
  if (config.mode === "log") {
    return createDevelopmentAuthEmailSender(logger);
  }

  return createDevelopmentAuthEmailSender(logger);
}

export const defaultAuthEmailSender = createAuthEmailSender();

export const createLoggingAuthEmailSender = createDevelopmentAuthEmailSender;
