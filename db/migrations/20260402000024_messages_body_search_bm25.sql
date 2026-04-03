-- migrate:up

CREATE EXTENSION IF NOT EXISTS pg_textsearch;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS body_search text
    GENERATED ALWAYS AS (
        left(coalesce(body, ''), 200000)
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_body_search_bm25
    ON messages
    USING bm25(body_search)
    WITH (text_config = 'english');

-- migrate:down

DROP INDEX IF EXISTS idx_messages_body_search_bm25;
ALTER TABLE messages DROP COLUMN IF EXISTS body_search;
DROP EXTENSION IF EXISTS pg_textsearch;
