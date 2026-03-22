-- migrate:up

CREATE TABLE user_email_claims (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL,
    claim_kind  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_email_claims_email_lowercase_check CHECK (email = lower(email)),
    CONSTRAINT user_email_claims_claim_kind_check CHECK (
        claim_kind IN ('registration', 'secondary_addition')
    )
);

CREATE TRIGGER trg_user_email_claims_normalize_email
    BEFORE INSERT OR UPDATE OF email ON user_email_claims
    FOR EACH ROW
    EXECUTE FUNCTION _normalize_auth_email();

CREATE UNIQUE INDEX idx_user_email_claims_user_email
    ON user_email_claims(user_id, email);

CREATE INDEX idx_user_email_claims_user_id
    ON user_email_claims(user_id);

CREATE INDEX idx_user_email_claims_email
    ON user_email_claims(email);

CREATE UNIQUE INDEX idx_user_email_claims_registration_email
    ON user_email_claims(email)
    WHERE claim_kind = 'registration';

INSERT INTO user_email_claims (user_id, email, claim_kind, created_at)
SELECT
    user_id,
    email,
    CASE
        WHEN is_primary THEN 'registration'
        ELSE 'secondary_addition'
    END,
    created_at
FROM user_emails
WHERE verified_at IS NULL;

DELETE FROM user_emails
WHERE verified_at IS NULL;

ALTER TABLE user_emails
    ALTER COLUMN verified_at SET NOT NULL;

-- migrate:down

ALTER TABLE user_emails
    ALTER COLUMN verified_at DROP NOT NULL;

INSERT INTO user_emails (user_id, email, is_primary, verified_at, created_at)
SELECT user_id, email, true, NULL, created_at
FROM user_email_claims
WHERE claim_kind = 'registration';

DROP INDEX IF EXISTS idx_user_email_claims_registration_email;
DROP INDEX IF EXISTS idx_user_email_claims_email;
DROP INDEX IF EXISTS idx_user_email_claims_user_id;
DROP INDEX IF EXISTS idx_user_email_claims_user_email;
DROP TRIGGER IF EXISTS trg_user_email_claims_normalize_email ON user_email_claims;
DROP TABLE IF EXISTS user_email_claims;
