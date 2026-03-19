-- migrate:up

CREATE INDEX IF NOT EXISTS idx_threads_page_order
    ON threads (last_activity_at DESC NULLS LAST, thread_id ASC);

-- migrate:down

DROP INDEX IF EXISTS idx_threads_page_order;
