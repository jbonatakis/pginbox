-- migrate:up

ALTER TABLE threads ADD COLUMN id TEXT;

DO $$
DECLARE
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    next_id TEXT;
    thread_row RECORD;
BEGIN
    FOR thread_row IN SELECT thread_id FROM threads WHERE id IS NULL LOOP
        LOOP
            next_id := '';
            FOR i IN 1..10 LOOP
                next_id := next_id || substr(
                    alphabet,
                    1 + floor(random() * length(alphabet))::INTEGER,
                    1
                );
            END LOOP;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM threads WHERE id = next_id);
        END LOOP;

        UPDATE threads
        SET id = next_id
        WHERE thread_id = thread_row.thread_id;
    END LOOP;
END;
$$;

ALTER TABLE threads ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX idx_threads_id ON threads (id);

-- migrate:down

DROP INDEX IF EXISTS idx_threads_id;
ALTER TABLE threads DROP COLUMN IF EXISTS id;
DROP FUNCTION IF EXISTS generate_thread_stable_id();
