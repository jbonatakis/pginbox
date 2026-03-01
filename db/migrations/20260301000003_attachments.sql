-- migrate:up

CREATE TABLE attachments (
    id           BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    message_id   BIGINT NOT NULL REFERENCES messages(id),
    filename     TEXT,
    content_type TEXT,
    size_bytes   INT,
    content      TEXT    -- NULL for binaries; populated for text/*, .patch, .diff, decompressed .gz
);

CREATE INDEX idx_attachments_message_id ON attachments (message_id);

-- migrate:down

DROP TABLE attachments;
