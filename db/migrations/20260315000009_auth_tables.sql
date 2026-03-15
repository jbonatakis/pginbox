-- migrate:up

CREATE FUNCTION _normalize_auth_email() RETURNS TRIGGER AS $$
BEGIN
    NEW.email := lower(NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
    id                BIGSERIAL   PRIMARY KEY,
    email             TEXT        NOT NULL UNIQUE,
    display_name      TEXT,
    password_hash     TEXT        NOT NULL,
    status            TEXT        NOT NULL CHECK (status IN ('pending_verification', 'active', 'disabled')),
    email_verified_at TIMESTAMPTZ,
    last_login_at     TIMESTAMPTZ,
    disabled_at       TIMESTAMPTZ,
    disable_reason    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_lowercase_check CHECK (email = lower(email)),
    CONSTRAINT users_status_state_check CHECK (
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
    )
);

CREATE TRIGGER trg_users_normalize_email
    BEFORE INSERT OR UPDATE OF email ON users
    FOR EACH ROW
    EXECUTE FUNCTION _normalize_auth_email();

CREATE TABLE auth_sessions (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    ip_address  INET,
    user_agent  TEXT,
    CONSTRAINT auth_sessions_last_seen_after_create_check CHECK (last_seen_at >= created_at),
    CONSTRAINT auth_sessions_expires_after_create_check CHECK (expires_at > created_at),
    CONSTRAINT auth_sessions_revoked_after_create_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_auth_sessions_user_id ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

CREATE TABLE email_verification_tokens (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL,
    token_hash  TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT email_verification_tokens_email_lowercase_check CHECK (email = lower(email)),
    CONSTRAINT email_verification_tokens_expires_after_create_check CHECK (expires_at > created_at),
    CONSTRAINT email_verification_tokens_consumed_after_create_check CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    )
);

CREATE TRIGGER trg_email_verification_tokens_normalize_email
    BEFORE INSERT OR UPDATE OF email ON email_verification_tokens
    FOR EACH ROW
    EXECUTE FUNCTION _normalize_auth_email();

CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens (user_id);
CREATE UNIQUE INDEX idx_email_verification_tokens_user_id_unconsumed
    ON email_verification_tokens (user_id)
    WHERE consumed_at IS NULL;

CREATE TABLE password_reset_tokens (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT password_reset_tokens_expires_after_create_check CHECK (expires_at > created_at),
    CONSTRAINT password_reset_tokens_consumed_after_create_check CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    )
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);
CREATE UNIQUE INDEX idx_password_reset_tokens_user_id_unconsumed
    ON password_reset_tokens (user_id)
    WHERE consumed_at IS NULL;

CREATE FUNCTION _revoke_auth_sessions_for_disabled_user() RETURNS TRIGGER AS $$
BEGIN
    UPDATE auth_sessions
    SET revoked_at = now()
    WHERE user_id = NEW.id
      AND revoked_at IS NULL;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_revoke_sessions_on_disable
    AFTER UPDATE OF status ON users
    FOR EACH ROW
    WHEN (NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled')
    EXECUTE FUNCTION _revoke_auth_sessions_for_disabled_user();

-- migrate:down

DROP TRIGGER IF EXISTS trg_users_revoke_sessions_on_disable ON users;
DROP TRIGGER IF EXISTS trg_email_verification_tokens_normalize_email ON email_verification_tokens;
DROP TRIGGER IF EXISTS trg_users_normalize_email ON users;

DROP FUNCTION IF EXISTS _revoke_auth_sessions_for_disabled_user();
DROP FUNCTION IF EXISTS _normalize_auth_email();

DROP INDEX IF EXISTS idx_password_reset_tokens_user_id_unconsumed;
DROP INDEX IF EXISTS idx_password_reset_tokens_user_id;
DROP INDEX IF EXISTS idx_email_verification_tokens_user_id_unconsumed;
DROP INDEX IF EXISTS idx_email_verification_tokens_user_id;
DROP INDEX IF EXISTS idx_auth_sessions_expires_at;
DROP INDEX IF EXISTS idx_auth_sessions_user_id;

DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS email_verification_tokens;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS users;
