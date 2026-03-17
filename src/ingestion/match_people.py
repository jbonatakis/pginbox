#!/usr/bin/env python3
"""
Discover and link additional email addresses to known people.

Each pass implements a matching strategy. Passes are idempotent — safe to
re-run, only inserts rows not already in people_emails. Add new passes over
time to improve coverage.

Usage:
    python3 match_people.py [--dry-run]
"""

import argparse
import os
import psycopg2
from psycopg2.extras import execute_batch
from dotenv import load_dotenv

load_dotenv()


DSN = os.environ.get(
    "DATABASE_URL", "postgresql://pginbox:pginbox@localhost:5499/pginbox"
)


# ---------------------------------------------------------------------------
# Pass runner
# ---------------------------------------------------------------------------


def run_pass(conn, name: str, candidates: list[tuple[int, str]], dry_run: bool):
    """Insert (person_id, email) candidates not already in people_emails."""
    if not candidates:
        print(f"  [{name}] no candidates found")
        return

    if dry_run:
        print(f"  [{name}] {len(candidates)} candidates (dry run — not inserted):")
        for person_id, email in candidates[:20]:
            with conn.cursor() as cur:
                cur.execute("SELECT name FROM people WHERE id = %s", (person_id,))
                person_name = cur.fetchone()[0]
            print(f"    {person_name:<30s}  {email}")
        if len(candidates) > 20:
            print(f"    ... and {len(candidates) - 20} more")
        return

    with conn.cursor() as cur:
        execute_batch(
            cur,
            "INSERT INTO people_emails (person_id, email) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            candidates,
        )
        inserted = cur.rowcount
    conn.commit()
    print(
        f"  [{name}] {inserted} new aliases inserted ({len(candidates) - inserted} already known)"
    )


# ---------------------------------------------------------------------------
# Pass 1: Exact from_name match
#
# If a message's from_name exactly matches a person's name and the from_email
# is not already linked to anyone, link it.
# ---------------------------------------------------------------------------


def pass_exact_name(conn) -> list[tuple[int, str]]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT p.id, m.from_email
            FROM messages m
            JOIN people p ON p.name = m.from_name
            WHERE m.from_email != ''
              AND NOT EXISTS (
                  SELECT 1 FROM people_emails pe WHERE pe.email = m.from_email
              )
        """)
        return cur.fetchall()


# ---------------------------------------------------------------------------
# Pass 2: Manual overrides
#
# Hard-coded mappings for cases that can't be resolved automatically —
# ambiguous names, display name changes, etc. Add entries here as needed.
# Format: (canonical_name, [extra_emails])
# ---------------------------------------------------------------------------

MANUAL_OVERRIDES = [
    # Name variants — same person, display name differs from canonical
    ("Jonathan Katz", ["jkatz@postgresql.org"]),  # posts as "Jonathan S. Katz"
]


def pass_manual_overrides(conn) -> list[tuple[int, str]]:
    candidates = []
    with conn.cursor() as cur:
        for name, emails in MANUAL_OVERRIDES:
            cur.execute("SELECT id FROM people WHERE name = %s", (name,))
            row = cur.fetchone()
            if not row:
                print(
                    f"    [warn] manual override: person '{name}' not found in people table"
                )
                continue
            person_id = row[0]
            for email in emails:
                candidates.append((person_id, email.lower().strip()))
    return candidates


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

PASSES = [
    ("exact-name", pass_exact_name),
    ("manual-overrides", pass_manual_overrides),
]


def main():
    parser = argparse.ArgumentParser(
        description="Match email addresses to known people"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Show candidates without inserting"
    )
    args = parser.parse_args()

    conn = psycopg2.connect(DSN)

    if args.dry_run:
        print("=== Dry run — no changes will be made ===\n")

    for name, fn in PASSES:
        candidates = fn(conn)
        run_pass(conn, name, candidates, args.dry_run)

    if not args.dry_run:
        # Summary
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    count(*) FILTER (WHERE pe.person_id IS NOT NULL) AS matched,
                    count(*) AS total
                FROM messages m
                LEFT JOIN people_emails pe ON pe.email = m.from_email
            """)
            matched, total = cur.fetchone()
        pct = matched / total * 100 if total else 0
        print(
            f"\n=== {matched:,}/{total:,} messages now matched to a person ({pct:.1f}%) ==="
        )

    conn.close()


if __name__ == "__main__":
    main()
