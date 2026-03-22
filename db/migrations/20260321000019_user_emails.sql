-- migrate:up

-- Create user_emails table: stores all email addresses per user
CREATE TABLE user_emails (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL UNIQUE,
    is_primary  BOOLEAN     NOT NULL DEFAULT false,
    verified_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_emails_email_lowercase_check CHECK (email = lower(email))
);

CREATE TRIGGER trg_user_emails_normalize_email
    BEFORE INSERT OR UPDATE OF email ON user_emails
    FOR EACH ROW
    EXECUTE FUNCTION _normalize_auth_email();

-- At most one primary email per user (enforced at DB level)
CREATE UNIQUE INDEX idx_user_emails_user_primary
    ON user_emails(user_id)
    WHERE is_primary = true;

CREATE INDEX idx_user_emails_user_id ON user_emails(user_id);

-- Backfill from existing users
INSERT INTO user_emails (user_id, email, is_primary, verified_at, created_at)
SELECT id, email, true, email_verified_at, created_at
FROM users;

-- Update email_verification_tokens index: allow one unconsumed token per (user, email)
-- Previously it was one per user; now it's one per user+email pair
DROP INDEX idx_email_verification_tokens_user_id_unconsumed;

CREATE UNIQUE INDEX idx_email_verification_tokens_user_email_unconsumed
    ON email_verification_tokens (user_id, email)
    WHERE consumed_at IS NULL;

-- Drop email-related columns and constraints from users
DROP TRIGGER trg_users_normalize_email ON users;
ALTER TABLE users DROP CONSTRAINT users_email_lowercase_check;
ALTER TABLE users DROP CONSTRAINT users_status_state_check;
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN email_verified_at;

-- Simplified status constraint (email_verified_at no longer on users)
ALTER TABLE users ADD CONSTRAINT users_status_state_check CHECK (
    (
        status = 'pending_verification'
        AND disabled_at IS NULL
        AND disable_reason IS NULL
    ) OR (
        status = 'active'
        AND disabled_at IS NULL
        AND disable_reason IS NULL
    ) OR (
        status = 'disabled'
        AND disabled_at IS NOT NULL
    )
);

-- migrate:down

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

UPDATE users u
SET email = ue.email,
    email_verified_at = ue.verified_at
FROM user_emails ue
WHERE ue.user_id = u.id AND ue.is_primary = true;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ADD UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT users_email_lowercase_check CHECK (email = lower(email));

CREATE TRIGGER trg_users_normalize_email
    BEFORE INSERT OR UPDATE OF email ON users
    FOR EACH ROW
    EXECUTE FUNCTION _normalize_auth_email();

DROP INDEX IF EXISTS idx_email_verification_tokens_user_email_unconsumed;

CREATE UNIQUE INDEX idx_email_verification_tokens_user_id_unconsumed
    ON email_verification_tokens (user_id)
    WHERE consumed_at IS NULL;

ALTER TABLE users DROP CONSTRAINT users_status_state_check;
ALTER TABLE users ADD CONSTRAINT users_status_state_check CHECK (
    (
        status = 'pending_verification'
        AND email_verified_at IS NULL
        AND disabled_at IS NULL
        AND disable_reason IS NULL
    ) OR (
        status = 'active'
        AND email_verified_at IS NOT NULL
        AND disabled_at IS NULL
        AND disable_reason IS NULL
    ) OR (
        status = 'disabled'
        AND disabled_at IS NOT NULL
    )
);

DROP TRIGGER IF EXISTS trg_user_emails_normalize_email ON user_emails;
DROP INDEX IF EXISTS idx_user_emails_user_primary;
DROP INDEX IF EXISTS idx_user_emails_user_id;
DROP TABLE IF EXISTS user_emails;
