-- migrate:up

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS archive_month DATE;

UPDATE messages
SET archive_month = date_trunc('month', sent_at AT TIME ZONE 'UTC')::date
WHERE archive_month IS NULL
  AND sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_list_archive_month
    ON messages (list_id, archive_month);

-- migrate:down

DROP INDEX IF EXISTS idx_messages_list_archive_month;

ALTER TABLE messages
    DROP COLUMN IF EXISTS archive_month;
