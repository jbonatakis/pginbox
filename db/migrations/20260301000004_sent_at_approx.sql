-- migrate:up

ALTER TABLE messages ADD COLUMN sent_at_approx boolean NOT NULL DEFAULT false;

-- migrate:down

ALTER TABLE messages DROP COLUMN sent_at_approx;
