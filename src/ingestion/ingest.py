#!/usr/bin/env python3
"""
POC: Download, parse, and store PostgreSQL mailing list mbox archives into Postgres.

Usage:
    # Live (upserts threads per message):
    python3 ingest.py --year 2026 --month 2

    # Backfill (bulk insert messages, derive threads at the end):
    python3 ingest.py --year 2026 --month 2 --backfill

    Credentials via --pg-user/--pg-pass or PG_LIST_USER/PG_LIST_PASS env vars.
    DB via --dsn or DATABASE_URL env var.
"""

import argparse
import email.header
import email.utils
import hashlib
import mailbox
import os
import re
import sys
import time
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_batch
import requests
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

class MonthNotFound(Exception):
    pass


LOGIN_URL = "https://www.postgresql.org/account/login/"
BASE_URL = "https://www.postgresql.org/list/{list_name}/mbox/{list_name}.{year_month}"
CACHE_DIR = Path("mbox_cache")
CHUNK_SIZE = 64 * 1024  # 64 KB



# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def mbox_cache_path(year: int, month: int, list_name: str) -> Path:
    return CACHE_DIR / f"{list_name}.{year:04d}{month:02d}"

def is_cached(year: int, month: int, list_name: str) -> bool:
    p = mbox_cache_path(year, month, list_name)
    return p.exists() and p.stat().st_size > 0


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def make_session(username: str, password: str) -> requests.Session:
    """Log in to postgresql.org and return an authenticated session."""
    session = requests.Session()

    resp = session.get(LOGIN_URL, timeout=30)
    resp.raise_for_status()

    csrf = session.cookies.get("csrftoken")
    if not csrf:
        raise RuntimeError("Could not find CSRF token in login page response")

    payload = {
        "csrfmiddlewaretoken": csrf,
        "username": username,
        "password": password,
        "this_is_the_login_form": "1",
        "next": "",
    }
    login_resp = session.post(LOGIN_URL, data=payload, headers={"Referer": LOGIN_URL}, timeout=30)
    login_resp.raise_for_status()

    if "id_password" in login_resp.text:
        raise RuntimeError("Login failed — check your postgresql.org username/password")

    print("  [auth] logged in successfully")
    return session


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------

def _validate_list(session: requests.Session, list_name: str, year: int, month: int):
    """Probe the mbox URL to confirm the list name is valid before registering it."""
    year_month = f"{year:04d}{month:02d}"
    url = BASE_URL.format(list_name=list_name, year_month=year_month)
    print(f"  [validate] probing {url} ...", end="", flush=True)
    with session.get(url, stream=True, timeout=30) as resp:
        content_type = resp.headers.get("content-type", "")
        if resp.status_code != 200 or "text/html" in content_type:
            raise RuntimeError(
                f"List '{list_name}' does not appear to be valid "
                f"(HTTP {resp.status_code}, content-type={content_type!r}, url={resp.url})"
            )
    print(" ok")


def ensure_list(conn, session: requests.Session, list_name: str, year: int, month: int) -> int:
    """Return the list_id for list_name, registering it if this is the first time we've seen it.

    Validation (probing the mbox URL) is skipped when the file is already cached,
    since a successful prior download is proof enough the list exists.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM lists WHERE name = %s", (list_name,))
        row = cur.fetchone()
        if row:
            return row[0]

    # New list — validate unless we already have a cached file for it
    if not is_cached(year, month, list_name):
        _validate_list(session, list_name, year, month)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO lists (name) VALUES (%s) ON CONFLICT (name) DO NOTHING RETURNING id",
            (list_name,),
        )
        row = cur.fetchone()
        if row is None:
            # Inserted by a concurrent process between our SELECT and INSERT
            cur.execute("SELECT id FROM lists WHERE name = %s", (list_name,))
            row = cur.fetchone()
        list_id = row[0]
    conn.commit()
    print(f"  [list] '{list_name}' registered (id={list_id})")
    return list_id


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_mbox(
    session: requests.Session,
    year: int,
    month: int,
    list_name: str,
    force: bool = False,
) -> Path:
    """Download the mbox file for the given month, caching it locally."""
    year_month = f"{year:04d}{month:02d}"
    url = BASE_URL.format(list_name=list_name, year_month=year_month)
    out_path = CACHE_DIR / f"{list_name}.{year_month}"

    CACHE_DIR.mkdir(exist_ok=True)

    if out_path.exists() and out_path.stat().st_size > 0 and not force:
        size_mb = out_path.stat().st_size / 1e6
        print(f"  [cache] {out_path} ({size_mb:.1f} MB)")
        return out_path

    tmp_path = out_path.with_suffix(".tmp")
    print(f"  [download] {url}")
    try:
        with session.get(url, stream=True, timeout=300) as resp:
            if resp.status_code == 404:
                raise MonthNotFound(f"No mbox found for {list_name} {year_month} (404)")
            resp.raise_for_status()
            if "text/html" in resp.headers.get("content-type", ""):
                raise RuntimeError(
                    f"Got HTML instead of mbox — authentication may have expired. URL: {resp.url}"
                )
            total = int(resp.headers.get("content-length", 0))
            downloaded = 0
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded / total * 100
                        print(
                            f"\r    {downloaded / 1e6:.1f} / {total / 1e6:.1f} MB  ({pct:.0f}%)",
                            end="",
                            flush=True,
                        )
            print()

        if total and downloaded != total:
            raise RuntimeError(
                f"Download incomplete: expected {total} bytes, got {downloaded}"
            )

        if downloaded == 0:
            raise MonthNotFound(f"No mbox found for {list_name} {year_month} (empty response)")
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    tmp_path.rename(out_path)
    size_mb = out_path.stat().st_size / 1e6
    print(f"  [saved] {out_path} ({size_mb:.1f} MB)")
    return out_path


# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

def _decode_body(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    payload = part.get_payload(decode=True)
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
                except Exception:
                    return str(part.get_payload())
        return ""
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace")
        except Exception:
            pass
        return str(msg.get_payload() or "")


def _decode_header(value: str) -> str:
    """Decode MIME encoded-word sequences (e.g. =?UTF-8?q?...?=) in a header value."""
    parts = []
    for part, charset in email.header.decode_header(value):
        if isinstance(part, bytes):
            parts.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(part)
    return "".join(parts)


def _normalize_email(addr: str) -> str:
    """Lowercase and strip +tags (e.g. user+tag@example.com → user@example.com)."""
    addr = addr.lower().strip()
    return re.sub(r'\+[^@]*@', '@', addr)


def _normalize_subject(subject: str) -> str:
    return re.sub(r'^(Re|Fwd?)\s*:\s*', '', subject, flags=re.IGNORECASE).strip()


def _strip_nul(s: str) -> str:
    """Remove NUL bytes that PostgreSQL rejects in text fields."""
    return s.replace('\x00', '') if s else s


def parse_mbox(path: Path, list_id: int):
    """Yield message dicts parsed from an mbox file."""
    mbox = mailbox.mbox(str(path))

    for msg in mbox:
        # Skip header-less fragments caused by unescaped "From " lines in bodies
        if not msg.keys():
            continue

        # Message-ID
        message_id = (msg.get("Message-ID") or "").strip()
        if not message_id:
            digest = hashlib.sha256(str(msg).encode()).hexdigest()[:16]
            message_id = f"<synthetic-{digest}@pginbox>"

        # Date — prefer the mbox From-line timestamp (set by the list server on
        # delivery) over the Date header (set by the sender, can be wrong).
        # git format-patch emails use a dummy From-line date (year 2001), so
        # we fall back to the Date header for those.
        sent_at = None
        from_line = msg.get_from() or ""
        from_line_parts = from_line.split(" ", 1)
        if len(from_line_parts) == 2:
            try:
                parsed = email.utils.parsedate_to_datetime(from_line_parts[1])
                if parsed.year > 2001:  # skip git's dummy "Mon Sep 17 00:00:00 2001"
                    sent_at = parsed
            except Exception:
                pass
        if sent_at is None:
            date_str = msg.get("Date") or ""
            if date_str:
                try:
                    sent_at = email.utils.parsedate_to_datetime(date_str)
                except Exception:
                    pass

        # From
        from_name, from_email = "", ""
        from_str = msg.get("From") or ""
        if from_str:
            name, addr = email.utils.parseaddr(_decode_header(from_str))
            from_name = name or ""
            from_email = _normalize_email(addr) if addr else ""

        in_reply_to = (msg.get("In-Reply-To") or "").strip() or None

        refs = [r.strip() for r in (msg.get("References") or "").split() if r.strip()]

        # Thread root is the oldest ancestor in References, or self if this is a new thread
        thread_id = refs[0] if refs else message_id

        subject = msg.get("Subject") or ""

        body = _strip_nul(_decode_body(msg))
        subject = _strip_nul(subject)
        yield {
            "message_id": _strip_nul(message_id),
            "thread_id": _strip_nul(thread_id),
            "list_id": list_id,
            "sent_at": sent_at,
            "from_name": _strip_nul(from_name),
            "from_email": _strip_nul(from_email),
            "subject": subject,
            "in_reply_to": _strip_nul(in_reply_to) if in_reply_to else None,
            "refs": [_strip_nul(r) for r in refs] if refs else None,
            "body": body,
            "_normalized_subject": _normalize_subject(subject),
        }


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

UPSERT_THREAD_SQL = """
    INSERT INTO threads (thread_id, list_id, subject, started_at, last_activity_at, message_count)
    VALUES (%(thread_id)s, %(list_id)s, %(_normalized_subject)s, %(sent_at)s, %(sent_at)s, 1)
    ON CONFLICT (thread_id) DO UPDATE SET
        last_activity_at = GREATEST(threads.last_activity_at, EXCLUDED.last_activity_at),
        message_count    = threads.message_count + 1
"""

INSERT_MESSAGE_SQL = """
    INSERT INTO messages
        (message_id, thread_id, list_id, sent_at, from_name, from_email,
         subject, in_reply_to, refs, body)
    VALUES
        (%(message_id)s, %(thread_id)s, %(list_id)s, %(sent_at)s,
         %(from_name)s, %(from_email)s, %(subject)s, %(in_reply_to)s, %(refs)s, %(body)s)
    ON CONFLICT (message_id) DO NOTHING
"""

# Used after bulk message insert during backfill to derive threads in one pass.
# Takes subject from the earliest message in each thread.
DERIVE_THREADS_SQL = """
    INSERT INTO threads (thread_id, list_id, subject, started_at, last_activity_at, message_count)
    SELECT
        thread_id,
        list_id,
        _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST))[1]),
        min(sent_at),
        max(sent_at),
        count(*)
    FROM messages
    GROUP BY thread_id, list_id
    ON CONFLICT (thread_id) DO UPDATE SET
        last_activity_at = GREATEST(threads.last_activity_at, EXCLUDED.last_activity_at),
        message_count    = EXCLUDED.message_count
"""



def store_batch_live(conn, batch: list):
    """Upsert threads and insert messages in one transaction (live ingestion)."""
    with conn.cursor() as cur:
        execute_batch(cur, UPSERT_THREAD_SQL, batch, page_size=500)
        execute_batch(cur, INSERT_MESSAGE_SQL, batch, page_size=500)
    conn.commit()


def store_batch_backfill(conn, batch: list):
    """Insert messages only; threads derived separately at the end."""
    with conn.cursor() as cur:
        execute_batch(cur, INSERT_MESSAGE_SQL, batch, page_size=500)
    conn.commit()


def derive_threads(conn):
    """Derive threads table from messages. Run once after backfill is complete."""
    print("  [derive threads]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute(DERIVE_THREADS_SQL)
        count = cur.rowcount
    conn.commit()
    print(f" {count} threads upserted")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def month_range(from_year: int, from_month: int, to_year: int, to_month: int):
    """Yield (year, month) tuples inclusive of both endpoints."""
    year, month = from_year, from_month
    while (year, month) <= (to_year, to_month):
        yield year, month
        month += 1
        if month > 12:
            month = 1
            year += 1


def ingest(
    conn,
    session: requests.Session,
    year: int,
    month: int,
    list_name: str = "pgsql-hackers",
    force_download: bool = False,
    backfill: bool = False,
    derive: bool = True,
):
    print(f"\n=== {list_name}  {year:04d}-{month:02d} {'[backfill]' if backfill else '[live]'} ===")

    list_id = ensure_list(conn, session, list_name, year, month)
    try:
        path = download_mbox(session, year, month, list_name, force=force_download)
    except MonthNotFound as e:
        print(f"  [skip] {e}")
        return 0

    print(f"  [parse+store] {path.name}")
    batch: list = []
    total = 0
    store_batch = store_batch_backfill if backfill else store_batch_live

    for record in parse_mbox(path, list_id):
        batch.append(record)
        if len(batch) >= 500:
            store_batch(conn, batch)
            total += len(batch)
            print(f"    ...{total} messages stored", end="\r", flush=True)
            batch = []

    if batch:
        store_batch(conn, batch)
        total += len(batch)

    print(f"  [done] {total} messages ingested")

    if backfill and derive:
        derive_threads(conn)

    return total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_year_month(value: str):
    try:
        y, m = value.split("-")
        return int(y), int(m)
    except ValueError:
        raise argparse.ArgumentTypeError(f"Expected YYYY-MM, got {value!r}")


def main():
    parser = argparse.ArgumentParser(description="Ingest PostgreSQL mailing list mbox archives")
    parser.add_argument("--list", default="pgsql-hackers", dest="list_name",
                        help="List name (default: pgsql-hackers)")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""),
                        help="Postgres DSN (or set DATABASE_URL)")
    parser.add_argument("--pg-user", default=os.environ.get("PG_LIST_USER", ""),
                        help="postgresql.org account username (or set PG_LIST_USER)")
    parser.add_argument("--pg-pass", default=os.environ.get("PG_LIST_PASS", ""),
                        help="postgresql.org account password (or set PG_LIST_PASS)")
    parser.add_argument("--force-download", action="store_true",
                        help="Re-download even if cached")
    parser.add_argument("--backfill", action="store_true",
                        help="Bulk insert messages, derive threads at end (faster for historical data)")
    parser.add_argument("--delay", type=float, default=2.0,
                        help="Seconds to wait between downloads in range mode (default: 2)")

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--year", type=int, help="Single month: year")
    mode.add_argument("--from", dest="from_ym", type=_parse_year_month,
                      metavar="YYYY-MM", help="Range start (inclusive)")

    parser.add_argument("--month", type=int, help="Single month: month (required with --year)")
    parser.add_argument("--to", dest="to_ym", type=_parse_year_month,
                        metavar="YYYY-MM", help="Range end (inclusive, required with --from)")

    args = parser.parse_args()

    # Validate single vs range args
    if args.year is not None and args.month is None:
        parser.error("--month is required with --year")
    if args.from_ym is not None and args.to_ym is None:
        parser.error("--to is required with --from")

    # Build list of (year, month) to process
    if args.year is not None:
        months = [(args.year, args.month)]
    else:
        from_y, from_m = args.from_ym
        to_y, to_m = args.to_ym
        months = list(month_range(from_y, from_m, to_y, to_m))

    if not args.dsn:
        print("Error: provide --dsn or set DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    # Only auth if at least one month needs downloading
    needs_download = args.force_download or any(
        not is_cached(y, m, args.list_name) for y, m in months
    )
    if needs_download:
        if not args.pg_user or not args.pg_pass:
            print("Error: provide --pg-user/--pg-pass or set PG_LIST_USER/PG_LIST_PASS", file=sys.stderr)
            sys.exit(1)
        print("[auth] logging in to postgresql.org...")
        session = make_session(args.pg_user, args.pg_pass)
    else:
        session = requests.Session()

    conn = psycopg2.connect(args.dsn)

    grand_total = 0
    for i, (year, month) in enumerate(months):
        # In range backfill mode, defer derive_threads until the final month
        derive = not args.backfill or (i == len(months) - 1)
        grand_total += ingest(
            conn, session, year, month,
            args.list_name, args.force_download,
            args.backfill, derive,
        )
        if i < len(months) - 1:
            time.sleep(args.delay)

    if len(months) > 1:
        print(f"\n=== Total: {grand_total:,} messages across {len(months)} months ===")

    conn.close()


if __name__ == "__main__":
    main()
