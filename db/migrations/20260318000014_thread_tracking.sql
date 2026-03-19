-- migrate:up

CREATE TABLE IF NOT EXISTS thread_tracking (
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

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'thread_tracking_pkey'
          AND conrelid = 'public.thread_tracking'::regclass
    ) THEN
        ALTER TABLE public.thread_tracking
            ADD CONSTRAINT thread_tracking_pkey PRIMARY KEY (user_id, thread_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'thread_tracking_source_check'
          AND conrelid = 'public.thread_tracking'::regclass
    ) THEN
        ALTER TABLE public.thread_tracking
            ADD CONSTRAINT thread_tracking_source_check
            CHECK (manual_followed_at IS NOT NULL OR participated_at IS NOT NULL);
    END IF;
END $$;

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
FROM thread_follows
ON CONFLICT (user_id, thread_id) DO UPDATE SET
    anchor_message_id = CASE
        WHEN thread_tracking.manual_followed_at IS NULL THEN EXCLUDED.anchor_message_id
        ELSE thread_tracking.anchor_message_id
    END,
    manual_followed_at = COALESCE(thread_tracking.manual_followed_at, EXCLUDED.manual_followed_at),
    created_at = LEAST(thread_tracking.created_at, EXCLUDED.created_at),
    updated_at = GREATEST(thread_tracking.updated_at, EXCLUDED.updated_at);

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

DELETE FROM thread_follows;

INSERT INTO thread_follows (
    user_id,
    thread_id,
    anchor_message_id,
    created_at,
    updated_at
)
SELECT
    tt.user_id,
    tt.thread_id,
    tt.anchor_message_id,
    COALESCE(tt.manual_followed_at, tt.created_at),
    tt.updated_at
FROM thread_tracking
tt
WHERE tt.manual_followed_at IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM users
      WHERE users.id = tt.user_id
  );

DROP TABLE IF EXISTS thread_tracking;
