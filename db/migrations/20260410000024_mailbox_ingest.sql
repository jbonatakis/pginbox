-- migrate:up

ALTER TABLE lists
    ADD COLUMN IF NOT EXISTS tracked boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS source_folder text;

ALTER TABLE lists
    DROP CONSTRAINT IF EXISTS lists_tracked_requires_source_folder_check;

ALTER TABLE lists
    ADD CONSTRAINT lists_tracked_requires_source_folder_check
    CHECK (tracked = false OR source_folder IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_source_folder
    ON lists (source_folder)
    WHERE source_folder IS NOT NULL;

CREATE TABLE IF NOT EXISTS mailbox_sync_state (
    source_folder text PRIMARY KEY,
    list_id integer NOT NULL UNIQUE REFERENCES lists(id) ON DELETE CASCADE,
    mailbox_id text NOT NULL,
    email_query_state text,
    last_push_event_id text,
    last_successful_sync_at timestamptz,
    last_reconciled_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mailbox_receipts (
    id bigserial PRIMARY KEY,
    list_id integer NOT NULL REFERENCES lists(id) ON DELETE RESTRICT,
    source_folder text NOT NULL,
    mailbox_id text NOT NULL,
    jmap_email_id text NOT NULL,
    blob_id text NOT NULL,
    internal_date timestamptz,
    message_id_header text,
    parsed_message_id text,
    stored_message_db_id bigint REFERENCES messages(id) ON DELETE SET NULL,
    raw_sha256 text NOT NULL,
    raw_rfc822 bytea NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mailbox_receipts_status_check CHECK (
        status IN (
            'fetched',
            'parsed',
            'stored',
            'duplicate',
            'parse_failed',
            'store_failed',
            'unresolved_list'
        )
    ),
    CONSTRAINT mailbox_receipts_mailbox_email_unique UNIQUE (mailbox_id, jmap_email_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_receipts_status_created_id
    ON mailbox_receipts (status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_receipts_list_created_id
    ON mailbox_receipts (list_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_receipts_parsed_message_id
    ON mailbox_receipts (parsed_message_id);

-- migrate:down

DROP INDEX IF EXISTS idx_mailbox_receipts_parsed_message_id;
DROP INDEX IF EXISTS idx_mailbox_receipts_list_created_id;
DROP INDEX IF EXISTS idx_mailbox_receipts_status_created_id;
DROP TABLE IF EXISTS mailbox_receipts;
DROP TABLE IF EXISTS mailbox_sync_state;
DROP INDEX IF EXISTS idx_lists_source_folder;

ALTER TABLE lists
    DROP CONSTRAINT IF EXISTS lists_tracked_requires_source_folder_check;

ALTER TABLE lists
    DROP COLUMN IF EXISTS source_folder,
    DROP COLUMN IF EXISTS tracked;
