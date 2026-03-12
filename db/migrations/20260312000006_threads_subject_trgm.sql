-- migrate:up

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_threads_subject_trgm
    ON threads
    USING gin (subject gin_trgm_ops);

-- migrate:down

DROP INDEX IF EXISTS idx_threads_subject_trgm;
DROP EXTENSION IF EXISTS pg_trgm;
