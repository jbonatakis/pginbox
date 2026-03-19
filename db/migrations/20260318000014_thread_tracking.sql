-- migrate:up

CREATE TABLE thread_tracking (
    user_id                       BIGINT      NOT NULL,
    thread_id                     TEXT        NOT NULL,
    anchor_message_id             BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    manual_followed_at            TIMESTAMPTZ,
    participated_at               TIMESTAMPTZ,
    participation_suppressed_at   TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id),
    CONSTRAINT thread_tracking_source_check CHECK (
        manual_followed_at IS NOT NULL OR participated_at IS NOT NULL
    )
);

INSERT INTO thread_tracking (
    user_id,
    thread_id,
    anchor_message_id,
    manual_followed_at,
    participated_at,
    participation_suppressed_at,
    created_at,
    updated_at
)
SELECT
    user_id,
    thread_id,
    anchor_message_id,
    created_at,
    NULL,
    NULL,
    created_at,
    updated_at
FROM thread_follows;

ALTER TABLE thread_read_progress
    DROP CONSTRAINT IF EXISTS thread_read_progress_user_id_fkey,
    DROP CONSTRAINT IF EXISTS thread_read_progress_last_read_message_id_fkey;

ALTER TABLE thread_read_progress
    ADD CONSTRAINT thread_read_progress_last_read_message_id_fkey
        FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE RESTRICT;

-- migrate:down

ALTER TABLE thread_read_progress
    DROP CONSTRAINT IF EXISTS thread_read_progress_last_read_message_id_fkey;

DELETE FROM thread_read_progress
WHERE NOT EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = thread_read_progress.user_id
);

ALTER TABLE thread_read_progress
    ADD CONSTRAINT thread_read_progress_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    ADD CONSTRAINT thread_read_progress_last_read_message_id_fkey
        FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE CASCADE;

DROP TABLE IF EXISTS thread_tracking;
