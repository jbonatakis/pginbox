-- migrate:up

CREATE INDEX idx_messages_thread_id_sent_at_id
    ON messages (thread_id, sent_at, id);

-- migrate:down

DROP INDEX idx_messages_thread_id_sent_at_id;
