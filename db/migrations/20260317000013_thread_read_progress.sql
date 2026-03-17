-- migrate:up

CREATE TABLE thread_read_progress (
    user_id              BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id            TEXT        NOT NULL,
    last_read_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);

-- migrate:down

DROP TABLE IF EXISTS thread_read_progress;
