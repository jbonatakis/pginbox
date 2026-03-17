-- migrate:up

CREATE TABLE thread_follows (
    user_id           BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id         TEXT        NOT NULL,
    anchor_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);

-- migrate:down

DROP TABLE IF EXISTS thread_follows;
