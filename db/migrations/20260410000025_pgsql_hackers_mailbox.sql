-- migrate:up

INSERT INTO lists (name, tracked, source_folder)
VALUES ('pgsql-hackers', true, 'pginbox.dev/pgsql-hackers')
ON CONFLICT (name) DO UPDATE SET
    tracked = EXCLUDED.tracked,
    source_folder = EXCLUDED.source_folder;

-- migrate:down

UPDATE lists
SET tracked = false,
    source_folder = NULL
WHERE name = 'pgsql-hackers'
  AND source_folder = 'pginbox.dev/pgsql-hackers';
