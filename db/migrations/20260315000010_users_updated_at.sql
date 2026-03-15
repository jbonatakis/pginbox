-- migrate:up

CREATE FUNCTION _set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        NEW.updated_at := now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD CONSTRAINT users_updated_after_create_check CHECK (updated_at >= created_at);

CREATE TRIGGER trg_users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION _set_updated_at();

-- migrate:down

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_updated_after_create_check,
    DROP COLUMN IF EXISTS updated_at;

DROP FUNCTION IF EXISTS _set_updated_at();
