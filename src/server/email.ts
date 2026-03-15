import nodemailer from "nodemailer";
import {
  resolveAuthEmailRuntimeConfig,
  type AuthEmailRuntimeConfig,
  type SmtpAuthEmailRuntimeConfig,
} from "./config";

export interface VerificationEmailDelivery {
  displayName: string | null;
  email: string;
  expiresAt: Date;
  userId: bigint | number | string;
  verificationUrl: string;
}

export interface PasswordResetEmailDelivery {
  displayName: string | null;
  email: string;
  expiresAt: Date;
  resetUrl: string;
  userId: bigint | number | string;
}

export interface AuthEmailSender {
  sendVerificationEmail(payload: VerificationEmailDelivery): Promise<void>;
  sendPasswordResetEmail(payload: PasswordResetEmailDelivery): Promise<void>;
}

interface InfoLogger {
  info(message?: unknown, ...optionalParams: unknown[]): void;
}

interface MailMessage {
  from: string;
  html: string;
  subject: string;
  text: string;
  to: string;
}

interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

interface EmailContent {
  html: string;
  subject: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildHtmlEmailContent(
  payload: { displayName: string | null; expiresAt: Date },
  content: {
    actionLabel: string;
    actionUrl: string;
    intro: string;
    title: string;
  },
): string {
  const greeting = payload.displayName
    ? `Hello ${escapeHtml(payload.displayName)},`
    : "Hello,";
  const actionUrl = escapeHtml(content.actionUrl);

  return [
    "<!doctype html>",
    "<html>",
    "  <body style=\"margin:0;padding:24px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#102a43;background:#f5f7fa;\">",
    "    <div style=\"max-width:560px;margin:0 auto;padding:24px;border:1px solid #d9e2ec;border-radius:12px;background:#ffffff;\">",
    `      <h1 style="margin:0 0 16px;font-size:24px;color:#0b4ea2;">${escapeHtml(content.title)}</h1>`,
    `      <p style="margin:0 0 16px;">${greeting}</p>`,
    `      <p style="margin:0 0 16px;">${escapeHtml(content.intro)}</p>`,
    `      <p style="margin:0 0 20px;"><a href="${actionUrl}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#0b4ea2;color:#ffffff;text-decoration:none;font-weight:600;">${escapeHtml(content.actionLabel)}</a></p>`,
    `      <p style="margin:0 0 16px;">If the button does not work, copy and paste this URL into your browser:<br><a href="${actionUrl}" style="color:#0b4ea2;word-break:break-word;">${actionUrl}</a></p>`,
    `      <p style="margin:0 0 16px;color:#486581;">This link expires at ${escapeHtml(payload.expiresAt.toISOString())}.</p>`,
    "      <p style=\"margin:0;color:#486581;\">If you did not request this, you can ignore this email.</p>",
    "    </div>",
    "  </body>",
    "</html>",
  ].join("\n");
}

function formatRecipient(displayName: string | null, email: string): string {
  return displayName ? `"${displayName}" <${email}>` : email;
}

function formatSender(config: SmtpAuthEmailRuntimeConfig): string {
  return config.fromName ? `"${config.fromName}" <${config.fromEmail}>` : config.fromEmail;
}

function buildVerificationEmail(payload: VerificationEmailDelivery): EmailContent {
  return {
    html: buildHtmlEmailContent(payload, {
      actionLabel: "Verify your email",
      actionUrl: payload.verificationUrl,
      intro: "Open this link to verify your email address and activate your pginbox account.",
      title: "Verify your pginbox account",
    }),
    subject: "Verify your pginbox email address",
    text: [
      "Verify your pginbox account",
      "",
      `Hello${payload.displayName ? ` ${payload.displayName}` : ""},`,
      "",
      "Open this link to verify your email address and activate your account:",
      payload.verificationUrl,
      "",
      `This link expires at ${payload.expiresAt.toISOString()}.`,
      "",
      "If you did not create this account, you can ignore this email.",
    ].join("\n"),
  };
}

function buildPasswordResetEmail(payload: PasswordResetEmailDelivery): EmailContent {
  return {
    html: buildHtmlEmailContent(payload, {
      actionLabel: "Reset your password",
      actionUrl: payload.resetUrl,
      intro: "Open this link to choose a new password for your pginbox account.",
      title: "Reset your pginbox password",
    }),
    subject: "Reset your pginbox password",
    text: [
      "Reset your pginbox password",
      "",
      `Hello${payload.displayName ? ` ${payload.displayName}` : ""},`,
      "",
      "Open this link to choose a new password:",
      payload.resetUrl,
      "",
      `This link expires at ${payload.expiresAt.toISOString()}.`,
      "",
      "If you did not request a password reset, you can ignore this email.",
    ].join("\n"),
  };
}

export function createDevelopmentAuthEmailSender(logger: InfoLogger = console): AuthEmailSender {
  return {
    async sendVerificationEmail(payload) {
      logger.info(
        `[auth:dev-mail] verification email for user_id=${payload.userId} (${payload.expiresAt.toISOString()}): ${payload.verificationUrl}`
      );
    },

    async sendPasswordResetEmail(payload) {
      logger.info(
        `[auth:dev-mail] password reset email for user_id=${payload.userId} (${payload.expiresAt.toISOString()}): ${payload.resetUrl}`
      );
    },
  };
}

export function createSmtpAuthEmailSender(
  logger: InfoLogger = console,
  config: SmtpAuthEmailRuntimeConfig,
  transport: MailTransport = nodemailer.createTransport({
    auth: {
      pass: config.pass,
      user: config.user,
    },
    host: config.host,
    port: config.port,
    secure: config.secure,
  }),
): AuthEmailSender {
  return {
    async sendVerificationEmail(payload) {
      const content = buildVerificationEmail(payload);

      await transport.sendMail({
        from: formatSender(config),
        html: content.html,
        subject: content.subject,
        text: content.text,
        to: formatRecipient(payload.displayName, payload.email),
      });

      logger.info(`[auth:smtp-mail] verification email sent for user_id=${payload.userId}`);
    },

    async sendPasswordResetEmail(payload) {
      const content = buildPasswordResetEmail(payload);

      await transport.sendMail({
        from: formatSender(config),
        html: content.html,
        subject: content.subject,
        text: content.text,
        to: formatRecipient(payload.displayName, payload.email),
      });

      logger.info(`[auth:smtp-mail] password reset email sent for user_id=${payload.userId}`);
    },
  };
}

export function createAuthEmailSender(
  logger: InfoLogger = console,
  config: AuthEmailRuntimeConfig = resolveAuthEmailRuntimeConfig(),
): AuthEmailSender {
  if (config.mode === "smtp") {
    return createSmtpAuthEmailSender(logger, config);
  }

  if (config.mode === "log") {
    return createDevelopmentAuthEmailSender(logger);
  }

  return createDevelopmentAuthEmailSender(logger);
}

export const defaultAuthEmailSender = createAuthEmailSender();

export const createLoggingAuthEmailSender = createDevelopmentAuthEmailSender;
