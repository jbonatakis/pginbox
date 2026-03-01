-- migrate:up

CREATE TABLE lists (
    id    SERIAL PRIMARY KEY,
    name  TEXT   NOT NULL UNIQUE
);

CREATE FUNCTION _normalize_subject(subject TEXT) RETURNS TEXT AS $$
    SELECT trim(regexp_replace(subject, '^(Re|Fwd?)\s*:\s*', '', 'gi'))
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE threads (
    thread_id        TEXT        PRIMARY KEY,
    list_id          INTEGER     NOT NULL REFERENCES lists(id),
    subject          TEXT,
    started_at       TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    message_count    INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX idx_threads_list_id       ON threads (list_id);
CREATE INDEX idx_threads_last_activity ON threads (last_activity_at);

CREATE TABLE messages (
    id          BIGSERIAL   PRIMARY KEY,
    message_id  TEXT        NOT NULL UNIQUE,
    thread_id   TEXT        NOT NULL,
    list_id     INTEGER     NOT NULL REFERENCES lists(id),
    sent_at     TIMESTAMPTZ,
    from_name   TEXT,
    from_email  TEXT,
    subject     TEXT,
    in_reply_to TEXT,
    refs        TEXT[],
    body        TEXT
);

CREATE INDEX idx_messages_thread_id   ON messages (thread_id);
CREATE INDEX idx_messages_sent_at     ON messages (sent_at);
CREATE INDEX idx_messages_from_email  ON messages (from_email);
CREATE INDEX idx_messages_in_reply_to ON messages (in_reply_to);

-- migrate:down

DROP TABLE messages;
DROP TABLE threads;
DROP FUNCTION _normalize_subject;
DROP TABLE lists;
