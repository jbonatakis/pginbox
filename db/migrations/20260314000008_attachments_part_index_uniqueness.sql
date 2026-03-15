-- migrate:up

ALTER TABLE attachments
    ADD COLUMN part_index INTEGER;

COMMENT ON COLUMN attachments.part_index IS
    'Zero-based position of the extracted attachment within a message MIME part walk.';

-- Remove only byte-for-byte duplicate attachment rows. If a message has
-- historical parser-version variants, those rows are preserved.
WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY message_id, filename, content_type, size_bytes, content
            ORDER BY id DESC
        ) AS duplicate_rank
    FROM attachments
)
DELETE FROM attachments a
USING ranked r
WHERE a.id = r.id
  AND r.duplicate_rank > 1;

WITH indexed AS (
    SELECT
        id,
        row_number() OVER (PARTITION BY message_id ORDER BY id ASC) - 1 AS next_part_index
    FROM attachments
)
UPDATE attachments a
SET part_index = indexed.next_part_index
FROM indexed
WHERE a.id = indexed.id;

ALTER TABLE attachments
    ALTER COLUMN part_index SET NOT NULL;

CREATE UNIQUE INDEX idx_attachments_message_part_index
    ON attachments (message_id, part_index);

-- migrate:down

DROP INDEX IF EXISTS idx_attachments_message_part_index;

ALTER TABLE attachments
    DROP COLUMN IF EXISTS part_index;
