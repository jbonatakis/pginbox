-- migrate:up

CREATE TABLE thread_tracking_new (
    user_id                     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id                   TEXT        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    anchor_message_id           BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    manual_followed_at          TIMESTAMPTZ,
    participated_at             TIMESTAMPTZ,
    participation_suppressed_at TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id),
    CONSTRAINT thread_tracking_new_source_check CHECK (
        manual_followed_at IS NOT NULL OR participated_at IS NOT NULL
    )
);

WITH tracking_targets AS (
    SELECT
        tt.user_id,
        current_threads.id AS target_thread_id,
        tt.anchor_message_id,
        tt.manual_followed_at,
        tt.participated_at,
        tt.participation_suppressed_at,
        tt.created_at,
        tt.updated_at,
        GREATEST(
            COALESCE(tt.manual_followed_at, '-infinity'::timestamptz),
            COALESCE(tt.participated_at, '-infinity'::timestamptz),
            COALESCE(tt.participation_suppressed_at, '-infinity'::timestamptz),
            tt.created_at
        ) AS event_at
    FROM thread_tracking tt
    JOIN messages anchor_message
      ON anchor_message.id = tt.anchor_message_id
    JOIN threads current_threads
      ON current_threads.thread_id = anchor_message.thread_id
),
tracking_anchor_choice AS (
    SELECT DISTINCT ON (user_id, target_thread_id)
        user_id,
        target_thread_id,
        anchor_message_id
    FROM tracking_targets
    ORDER BY user_id, target_thread_id, event_at DESC, updated_at DESC, anchor_message_id DESC
),
tracking_merged AS (
    SELECT
        tt.user_id,
        tt.target_thread_id AS thread_id,
        ac.anchor_message_id,
        MAX(tt.manual_followed_at) AS manual_followed_at,
        MAX(tt.participated_at) AS participated_at,
        MAX(tt.participation_suppressed_at) AS participation_suppressed_at,
        MIN(tt.created_at) AS created_at,
        MAX(tt.updated_at) AS updated_at
    FROM tracking_targets tt
    JOIN tracking_anchor_choice ac
      ON ac.user_id = tt.user_id
     AND ac.target_thread_id = tt.target_thread_id
    GROUP BY tt.user_id, tt.target_thread_id, ac.anchor_message_id
)
INSERT INTO thread_tracking_new (
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
    manual_followed_at,
    participated_at,
    participation_suppressed_at,
    created_at,
    updated_at
FROM tracking_merged;

CREATE TABLE thread_read_progress_new (
    user_id              BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id            TEXT        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    last_read_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);

WITH progress_targets AS (
    SELECT
        trp.user_id,
        current_threads.id AS target_thread_id,
        trp.last_read_message_id,
        trp.updated_at,
        last_read_message.sent_at
    FROM thread_read_progress trp
    JOIN messages last_read_message
      ON last_read_message.id = trp.last_read_message_id
    JOIN threads current_threads
      ON current_threads.thread_id = last_read_message.thread_id
),
progress_choice AS (
    SELECT DISTINCT ON (user_id, target_thread_id)
        user_id,
        target_thread_id,
        last_read_message_id,
        updated_at
    FROM progress_targets
    ORDER BY
        user_id,
        target_thread_id,
        sent_at DESC NULLS FIRST,
        last_read_message_id DESC,
        updated_at DESC
)
INSERT INTO thread_read_progress_new (
    user_id,
    thread_id,
    last_read_message_id,
    updated_at
)
SELECT
    user_id,
    target_thread_id AS thread_id,
    last_read_message_id,
    updated_at
FROM progress_choice;

DROP TABLE thread_read_progress;
ALTER TABLE thread_read_progress_new RENAME TO thread_read_progress;

DROP TABLE thread_tracking;
ALTER TABLE thread_tracking_new RENAME TO thread_tracking;
ALTER TABLE thread_tracking
    RENAME CONSTRAINT thread_tracking_new_source_check TO thread_tracking_source_check;

-- migrate:down

CREATE TABLE thread_tracking_old (
    user_id                     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id                   TEXT        NOT NULL,
    anchor_message_id           BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    manual_followed_at          TIMESTAMPTZ,
    participated_at             TIMESTAMPTZ,
    participation_suppressed_at TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id),
    CONSTRAINT thread_tracking_old_source_check CHECK (
        manual_followed_at IS NOT NULL OR participated_at IS NOT NULL
    )
);

INSERT INTO thread_tracking_old (
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
    tt.user_id,
    threads.thread_id,
    tt.anchor_message_id,
    tt.manual_followed_at,
    tt.participated_at,
    tt.participation_suppressed_at,
    tt.created_at,
    tt.updated_at
FROM thread_tracking tt
JOIN threads
  ON threads.id = tt.thread_id;

CREATE TABLE thread_read_progress_old (
    user_id              BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id            TEXT        NOT NULL,
    last_read_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);

INSERT INTO thread_read_progress_old (
    user_id,
    thread_id,
    last_read_message_id,
    updated_at
)
SELECT
    trp.user_id,
    threads.thread_id,
    trp.last_read_message_id,
    trp.updated_at
FROM thread_read_progress trp
JOIN threads
  ON threads.id = trp.thread_id;

DROP TABLE thread_read_progress;
ALTER TABLE thread_read_progress_old RENAME TO thread_read_progress;

DROP TABLE thread_tracking;
ALTER TABLE thread_tracking_old RENAME TO thread_tracking;
ALTER TABLE thread_tracking
    RENAME CONSTRAINT thread_tracking_old_source_check TO thread_tracking_source_check;
