-- migrate:up

CREATE TABLE people (
    id         SERIAL      PRIMARY KEY,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE people_emails (
    id        SERIAL  PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    email     TEXT    NOT NULL UNIQUE
);

CREATE INDEX idx_people_emails_person_id ON people_emails (person_id);

-- migrate:down

DROP TABLE people_emails;
DROP TABLE people;
