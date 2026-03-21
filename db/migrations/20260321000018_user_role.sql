-- migrate:up

ALTER TABLE users
    ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
        CONSTRAINT users_role_check CHECK (role IN ('member', 'admin'));

-- migrate:down

ALTER TABLE users DROP COLUMN role;
