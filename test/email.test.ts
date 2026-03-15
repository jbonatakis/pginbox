import { describe, expect, it } from "bun:test";
import {
  createAuthEmailSender,
  createDevelopmentAuthEmailSender,
  createSmtpAuthEmailSender,
} from "../src/server/email";
import { createAuthService } from "../src/server/services/auth.service";

class CapturingLogger {
  readonly messages: string[] = [];

  info(message?: unknown, ...optionalParams: unknown[]): void {
    this.messages.push(
      [message, ...optionalParams]
        .filter((value) => value !== undefined)
        .map((value) => String(value))
        .join(" "),
    );
  }
}

class CapturingTransport {
  messages: Array<{
    from: string;
    html: string;
    subject: string;
    text: string;
    to: string;
  }> = [];

  async sendMail(message: {
    from: string;
    html: string;
    subject: string;
    text: string;
    to: string;
  }): Promise<void> {
    this.messages.push(message);
  }
}

describe("auth email sender", () => {
  it("logs verification and reset emails in development mode", async () => {
    const logger = new CapturingLogger();
    const sender = createDevelopmentAuthEmailSender(logger);

    await sender.sendVerificationEmail({
      displayName: "Test User",
      email: "user@example.com",
      expiresAt: new Date("2026-03-16T12:00:00.000Z"),
      verificationUrl: "http://localhost:5173/verify-email?token=verify-token",
    });
    await sender.sendPasswordResetEmail({
      displayName: "Test User",
      email: "user@example.com",
      expiresAt: new Date("2026-03-15T13:00:00.000Z"),
      resetUrl: "http://localhost:5173/reset-password?token=reset-token",
    });

    expect(logger.messages).toEqual([
      "[auth:dev-mail] verification email for user@example.com (2026-03-16T12:00:00.000Z): http://localhost:5173/verify-email?token=verify-token",
      "[auth:dev-mail] password reset email for user@example.com (2026-03-15T13:00:00.000Z): http://localhost:5173/reset-password?token=reset-token",
    ]);
  });

  it("uses the development sender for dev auto-verify mode", async () => {
    const logger = new CapturingLogger();
    const sender = createAuthEmailSender(logger, { mode: "dev-auto-verify" });

    await sender.sendVerificationEmail({
      displayName: null,
      email: "user@example.com",
      expiresAt: new Date("2026-03-16T12:00:00.000Z"),
      verificationUrl: "http://localhost:5173/verify-email?token=verify-token",
    });

    expect(logger.messages.at(-1)).toContain("[auth:dev-mail] verification email");
  });

  it("constructs an SMTP sender when smtp mode is enabled", () => {
    const sender = createAuthEmailSender(new CapturingLogger(), {
      fromEmail: "no-reply@example.com",
      fromName: "pginbox",
      host: "smtp.example.com",
      mode: "smtp",
      pass: "secret",
      port: 587,
      secure: false,
      user: "smtp-user",
    });

    expect(sender.sendVerificationEmail).toBeFunction();
    expect(sender.sendPasswordResetEmail).toBeFunction();
  });

  it("sends multipart verification emails with a clickable HTML link in smtp mode", async () => {
    const transport = new CapturingTransport();
    const sender = createSmtpAuthEmailSender(
      new CapturingLogger(),
      {
        fromEmail: "no-reply@example.com",
        fromName: "pginbox",
        host: "smtp.example.com",
        mode: "smtp",
        pass: "secret",
        port: 587,
        secure: false,
        user: "smtp-user",
      },
      transport,
    );

    await sender.sendVerificationEmail({
      displayName: "<Test User>",
      email: "user@example.com",
      expiresAt: new Date("2026-03-16T12:00:00.000Z"),
      verificationUrl: "http://localhost:5173/verify-email?token=verify-token",
    });

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      from: '"pginbox" <no-reply@example.com>',
      subject: "Verify your pginbox email address",
      text: expect.stringContaining("http://localhost:5173/verify-email?token=verify-token"),
      to: '"<Test User>" <user@example.com>',
    });
    expect(transport.messages[0]?.html).toContain(
      '<a href="http://localhost:5173/verify-email?token=verify-token"',
    );
    expect(transport.messages[0]?.html).toContain("Hello &lt;Test User&gt;,");
  });

  it("requires an explicit app base URL when smtp mode is enabled", () => {
    const previousAppBaseUrl = process.env.APP_BASE_URL;
    delete process.env.APP_BASE_URL;

    try {
      expect(() =>
        createAuthService({
          emailRuntimeConfig: {
            fromEmail: "no-reply@example.com",
            fromName: "pginbox",
            host: "smtp.example.com",
            mode: "smtp",
            pass: "secret",
            port: 587,
            secure: false,
            user: "smtp-user",
          },
        })
      ).toThrow("AUTH_EMAIL_MODE=smtp requires APP_BASE_URL");
    } finally {
      if (previousAppBaseUrl === undefined) {
        delete process.env.APP_BASE_URL;
      } else {
        process.env.APP_BASE_URL = previousAppBaseUrl;
      }
    }
  });
});
