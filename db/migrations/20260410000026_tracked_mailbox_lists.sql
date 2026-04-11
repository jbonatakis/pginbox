-- migrate:up

INSERT INTO lists (name, tracked, source_folder)
VALUES
    ('pgsql-admin', true, 'pginbox.dev/pgsql-admin'),
    ('pgsql-bugs', true, 'pginbox.dev/pgsql-bugs'),
    ('pgsql-committers', true, 'pginbox.dev/pgsql-committers'),
    ('pgsql-docs', true, 'pginbox.dev/pgsql-docs'),
    ('pgsql-general', true, 'pginbox.dev/pgsql-general'),
    ('pgsql-www', true, 'pginbox.dev/pgsql-www')
ON CONFLICT (name) DO UPDATE SET
    tracked = EXCLUDED.tracked,
    source_folder = EXCLUDED.source_folder;

-- migrate:down

UPDATE lists
SET tracked = false,
    source_folder = NULL
WHERE (name, source_folder) IN (
    ('pgsql-admin', 'pginbox.dev/pgsql-admin'),
    ('pgsql-bugs', 'pginbox.dev/pgsql-bugs'),
    ('pgsql-committers', 'pginbox.dev/pgsql-committers'),
    ('pgsql-docs', 'pginbox.dev/pgsql-docs'),
    ('pgsql-general', 'pginbox.dev/pgsql-general'),
    ('pgsql-www', 'pginbox.dev/pgsql-www')
);
