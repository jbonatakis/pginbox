import { db } from "../db";
import { runAuthCleanup } from "../services/auth-maintenance.service";

try {
  const result = await runAuthCleanup();
  console.info(
    [
      "[auth:cleanup]",
      `completed_at=${result.completedAt.toISOString()}`,
      `expired_sessions_deleted=${result.expiredSessionsDeleted}`,
      `verification_tokens_deleted=${result.verificationTokensDeleted}`,
      `password_reset_tokens_deleted=${result.passwordResetTokensDeleted}`,
    ].join(" "),
  );
} catch (error) {
  console.error("[auth:cleanup] failed", error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
