#!/usr/bin/env python3
"""
POC: Download, parse, and store PostgreSQL mailing list mbox archives into Postgres.

Usage:
    # Live (inserts messages, refreshes affected threads):
    python3 ingest.py --year 2026 --month 2

    # Backfill (bulk insert messages, derive threads at the end):
    python3 ingest.py --year 2026 --month 2 --backfill

    # Rebuild canonical message.thread_id values and the derived threads table:
    python3 ingest.py --derive-only

    # Decode stored RFC 2047 message subjects and rebuild threads:
    python3 ingest.py --decode-subjects

    Credentials via --pg-user/--pg-pass or PG_LIST_USER/PG_LIST_PASS env vars.
    DB via --dsn or DATABASE_URL env var.
"""

import argparse
import email.header
import email.utils
import gzip
import hashlib
import mailbox
import os
import re
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

import psycopg2
from psycopg2.extras import execute_batch, execute_values
import requests
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

class MonthNotFound(Exception):
    pass


class ArchiveAuthError(RuntimeError):
    """Raised when archive downloads redirect to authentication endpoints."""


LOGIN_URL = "https://www.postgresql.org/account/login/"
BASE_URL = "https://www.postgresql.org/list/{list_name}/mbox/{list_name}.{year_month}"
LIST_AUTH_URL = "https://www.postgresql.org/list/_auth/accounts/login/"
CACHE_DIR = Path("mbox_cache")
CHUNK_SIZE = 64 * 1024  # 64 KB
HTTP_RETRIES = 5
HTTP_RETRY_BASE_DELAY = 2.0
MESSAGE_ID_RE = re.compile(r"<[^<>\r\n]+>")
GIT_PATCH_FROM_RE = re.compile(br"^From [0-9a-f]{7,64} Mon Sep 17 00:00:00 2001(?: .*)?$")
DEFAULT_LIST_NAME = "pgsql-hackers"



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


def _archive_auth_url(url: str) -> str:
    """Build the list-auth bootstrap URL used by the web UI's download form."""
    split = urlsplit(url)
    next_target = split.path + (f"?{split.query}" if split.query else "")
    return f"{LIST_AUTH_URL}?next={quote(next_target, safe='/?=&')}"


def _open_archive_response(
    session: requests.Session,
    url: str,
    timeout: int,
):
    """Open an archive response via list-auth bootstrap flow."""
    auth_url = _archive_auth_url(url)
    last_error = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            resp = session.get(auth_url, stream=True, timeout=timeout)
            break
        except requests.exceptions.TooManyRedirects as e:
            raise ArchiveAuthError(
                f"Archive request entered a redirect loop. URL: {auth_url}"
            ) from e
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_error = e
            if attempt >= HTTP_RETRIES:
                raise
            delay = HTTP_RETRY_BASE_DELAY * attempt
            print(
                f"  [retry] transient network error ({type(e).__name__}); "
                f"retrying in {delay:.1f}s ({attempt}/{HTTP_RETRIES - 1})"
            )
            time.sleep(delay)
    else:
        raise RuntimeError(f"Failed to open archive URL after retries: {auth_url}") from last_error

    content_type = resp.headers.get("content-type", "")
    if (
        "text/html" in content_type
        and any(
            marker in resp.url
            for marker in ("/account/login", "/list/_auth/accounts/login", "/account/auth/")
        )
    ):
        resp.close()
        raise ArchiveAuthError(
            f"Archive authentication failed or expired. Final URL: {resp.url}"
        )

    return resp


def ensure_archive_access(session: requests.Session, list_name: str, year: int, month: int):
    """Verify the current session can access archive data without auth redirects."""
    year_month = f"{year:04d}{month:02d}"
    url = BASE_URL.format(list_name=list_name, year_month=year_month)
    with _open_archive_response(session, url, timeout=30) as resp:
        if "text/html" in resp.headers.get("content-type", ""):
            raise ArchiveAuthError(
                f"Archive access returned HTML instead of mbox. URL: {resp.url}"
            )


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------

def _validate_list(session: requests.Session, list_name: str, year: int, month: int):
    """Probe the mbox URL to confirm the list name is valid before registering it."""
    year_month = f"{year:04d}{month:02d}"
    url = BASE_URL.format(list_name=list_name, year_month=year_month)
    print(f"  [validate] probing {url} ...", end="", flush=True)
    with _open_archive_response(session, url, timeout=30) as resp:
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
        with _open_archive_response(session, url, timeout=300) as resp:
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
            if part.get_content_type() != "text/plain":
                continue
            if part.get_content_disposition() == "attachment":
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace")
            except Exception:
                continue
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


_TEXT_APPLICATION_TYPES = {
    "application/sql", "application/x-sql",
    "application/x-sh", "application/x-shellscript",
    "application/x-perl", "application/x-perl-script",
    "application/x-python", "application/x-python-script",
    "application/x-ruby-script",
    "application/xhtml+xml",
}


def _parse_attachments(msg) -> list:
    """Extract attachments from a MIME message. Returns list of dicts."""
    if not msg.is_multipart():
        return []

    attachments = []
    for part in msg.walk():
        if part.is_multipart():
            continue

        ct = part.get_content_type()
        disp = part.get_content_disposition() or ""
        filename = part.get_filename()
        ext = filename.rsplit(".", 1)[-1].lower() if filename and "." in filename else ""

        # Skip signatures and noise
        if ct in (
            "application/pgp-signature",   # PGP signatures
            "application/pkcs7-signature", # S/MIME signatures
            "application/applefile",       # Mac resource forks
            "application/mbox",            # mbox-in-mbox
            "text/vnd.google.email-reaction+json",  # Gmail emoji reactions
        ):
            continue
        if ct.startswith("video/"):
            continue
        if ext == "asc":
            continue

        # Skip inline body parts (non-attachment text/plain and text/html alternatives)
        if ct in ("text/plain", "text/html") and disp != "attachment":
            continue

        payload = part.get_payload(decode=True)
        if not payload:
            continue
        size = len(payload)
        content = None

        if payload:
            if ct.startswith("text/") or ct in _TEXT_APPLICATION_TYPES or ext in ("patch", "diff"):
                charset = part.get_content_charset() or "utf-8"
                try:
                    content = payload.decode(charset, errors="replace")
                except Exception:
                    pass
            elif ct in ("application/gzip", "application/x-gzip", "application/x-compressed") or ext in ("gz", "tgz"):
                try:
                    content = gzip.decompress(payload).decode("utf-8")
                except Exception:
                    pass  # metadata-only

        attachments.append({
            "filename": _strip_nul(filename) if filename else None,
            "content_type": ct,
            "size_bytes": size,
            "content": _strip_nul(content) if content else None,
        })

    return attachments


def _decode_header(value: str) -> str:
    """Decode MIME encoded-word sequences (e.g. =?UTF-8?q?...?=) in a header value."""
    parts = []
    for part, charset in email.header.decode_header(value):
        if isinstance(part, bytes):
            parts.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(part)
    return "".join(parts)


def _decode_subject(value: str | None) -> str:
    return _strip_nul(_decode_header(value or ""))


def _normalize_email(addr: str) -> str:
    """Lowercase and strip +tags (e.g. user+tag@example.com → user@example.com)."""
    addr = addr.lower().strip()
    return re.sub(r'\+[^@]*@', '@', addr)


def _extract_message_ids(value: str | None) -> list[str]:
    decoded = _decode_header(value or "").strip()
    if not decoded:
        return []
    ids = MESSAGE_ID_RE.findall(decoded)
    if ids:
        return ids
    return [part for part in decoded.split() if part]


def _extract_message_id(value: str | None, *, prefer_last: bool = False) -> str | None:
    ids = _extract_message_ids(value)
    if not ids:
        return None
    return ids[-1] if prefer_last else ids[0]


def _normalize_subject(subject: str) -> str:
    return re.sub(r'^(Re|Fwd?)\s*:\s*', '', subject, flags=re.IGNORECASE).strip()


def _strip_nul(s: str) -> str:
    """Remove NUL bytes that PostgreSQL rejects in text fields."""
    return s.replace('\x00', '') if s else s


def _is_git_patch_from_line(raw: bytes) -> bool:
    return bool(GIT_PATCH_FROM_RE.match(raw.rstrip(b"\r\n")))


def _mbox_contains_git_patch_from_lines(path: Path) -> bool:
    with path.open("rb") as src:
        return any(_is_git_patch_from_line(raw) for raw in src)


def _sanitize_mbox_from_lines(path: Path) -> Path:
    """Create a temp mbox copy that escapes embedded git patch From-lines."""
    tmp = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f"{path.name}.",
        suffix=".sanitized",
        dir=path.parent,
        delete=False,
    )
    tmp_path = Path(tmp.name)
    try:
        with path.open("rb") as src, tmp:
            for raw in src:
                if _is_git_patch_from_line(raw):
                    raw = b">" + raw
                elif raw.startswith(b"From "):
                    raw = raw.decode("utf-8", errors="replace").encode("ascii", errors="replace")
                tmp.write(raw)
        return tmp_path
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _iter_mbox_messages(path: Path):
    if _mbox_contains_git_patch_from_lines(path):
        print("  [warn] detected embedded git patch From-lines; retrying with sanitized copy")
        sanitized_path = _sanitize_mbox_from_lines(path)
        try:
            mbox = mailbox.mbox(str(sanitized_path))
            try:
                for msg in mbox:
                    yield msg
                return
            finally:
                mbox.close()
        finally:
            sanitized_path.unlink(missing_ok=True)

    buffered = []
    mbox = mailbox.mbox(str(path))
    try:
        for msg in mbox:
            if not msg.keys():
                print("  [warn] detected header-less mbox fragments; retrying with sanitized copy")
                break
            buffered.append(msg)
        else:
            yield from buffered
            return
    except UnicodeDecodeError as e:
        print(f"  [warn] malformed mbox From-line ({e}); retrying with sanitized copy")
    finally:
        mbox.close()

    sanitized_path = _sanitize_mbox_from_lines(path)
    try:
        mbox = mailbox.mbox(str(sanitized_path))
        try:
            for msg in mbox:
                yield msg
        finally:
            mbox.close()
    finally:
        sanitized_path.unlink(missing_ok=True)


def parse_mbox(path: Path, list_id: int):
    """Yield message dicts parsed from an mbox file."""
    # Derive the mbox month from the filename (e.g. pgsql-hackers.202306)
    # Used to clamp dates for git format-patch emails whose Date header
    # reflects the git commit date rather than the actual send date.
    mbox_ym = path.name.split(".")[-1]
    mbox_date = datetime(int(mbox_ym[:4]), int(mbox_ym[4:]), 1, tzinfo=timezone.utc)

    for msg in _iter_mbox_messages(path):
        # Skip header-less fragments caused by unescaped "From " lines in bodies
        if not msg.keys():
            continue

        # Message-ID
        message_id = _extract_message_id(msg.get("Message-ID"))
        if not message_id:
            digest = hashlib.sha256(str(msg).encode()).hexdigest()[:16]
            message_id = f"<synthetic-{digest}@pginbox>"

        # Date — prefer the mbox From-line timestamp (set by the list server on
        # delivery) over the Date header (set by the sender, can be wrong).
        # git format-patch emails use a dummy From-line date (year 2001), so
        # we fall back to the Date header for those. If the Date header also
        # predates the mbox month (git commit date used as send date), clamp
        # to the first of the mbox month as the best available approximation.
        sent_at = None
        used_date_header = False
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
                    used_date_header = True
                except Exception:
                    pass
        sent_at_approx = False
        if used_date_header and sent_at is not None:
            aware = sent_at if sent_at.tzinfo else sent_at.replace(tzinfo=timezone.utc)
            if aware < mbox_date:
                sent_at = mbox_date
                sent_at_approx = True

        # From
        from_name, from_email = "", ""
        from_str = msg.get("From") or ""
        if from_str:
            name, addr = email.utils.parseaddr(_decode_header(from_str))
            from_name = name or ""
            from_email = _normalize_email(addr) if addr else ""

        in_reply_to = _extract_message_id(msg.get("In-Reply-To"), prefer_last=True)

        refs = _extract_message_ids(msg.get("References"))

        # Thread root is provisional here. Batch/global resolution can replace
        # self-rooted replies that only carry In-Reply-To.
        thread_id = refs[0] if refs else message_id

        body = _strip_nul(_decode_body(msg))
        subject = _decode_subject(msg.get("Subject"))
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
            "sent_at_approx": sent_at_approx,
            "_normalized_subject": _normalize_subject(subject),
            "_attachments": _parse_attachments(msg),
        }


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

UPSERT_TOUCHED_THREADS_SQL = """
    INSERT INTO threads (thread_id, list_id, subject, started_at, last_activity_at, message_count)
    SELECT
        thread_id,
        list_id,
        _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST))[1]),
        min(sent_at),
        max(sent_at),
        count(*)
    FROM messages
    WHERE thread_id = ANY(%s)
    GROUP BY thread_id, list_id
    ON CONFLICT (thread_id) DO UPDATE SET
        list_id          = EXCLUDED.list_id,
        subject          = EXCLUDED.subject,
        started_at       = EXCLUDED.started_at,
        last_activity_at = EXCLUDED.last_activity_at,
        message_count    = EXCLUDED.message_count
"""

INSERT_MESSAGE_COLUMNS = (
    "message_id",
    "thread_id",
    "list_id",
    "sent_at",
    "sent_at_approx",
    "from_name",
    "from_email",
    "subject",
    "in_reply_to",
    "refs",
    "body",
)

INSERT_MESSAGE_SQL = f"""
    INSERT INTO messages
        ({", ".join(INSERT_MESSAGE_COLUMNS)})
    VALUES %s
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id, message_id
"""

INSERT_MESSAGE_TEMPLATE = f"({', '.join(['%s'] * len(INSERT_MESSAGE_COLUMNS))})"

INSERT_ATTACHMENT_SQL = """
    INSERT INTO attachments (message_id, part_index, filename, content_type, size_bytes, content)
    VALUES (%(message_id)s, %(part_index)s, %(filename)s, %(content_type)s, %(size_bytes)s, %(content)s)
    ON CONFLICT (message_id, part_index) DO NOTHING
"""

DELETE_ATTACHMENTS_SQL = """
    DELETE FROM attachments
    WHERE message_id = ANY(%s)
"""

UPDATE_MESSAGE_THREAD_SQL = """
    UPDATE messages
    SET thread_id = %(thread_id)s
    WHERE message_id = %(message_id)s
"""

UPDATE_MESSAGE_SUBJECT_SQL = """
    UPDATE messages
    SET subject = %(subject)s
    WHERE message_id = %(message_id)s
"""

# Used after bulk message insert during backfill to rebuild threads in one pass.
# Takes subject from the earliest message in each thread.
REBUILD_THREADS_SQL = """
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
"""


def _fetch_thread_ids(cur, list_id: int, message_ids: list[str]) -> dict[str, str]:
    if not message_ids:
        return {}
    cur.execute(
        "SELECT message_id, thread_id FROM messages WHERE list_id = %s AND message_id = ANY(%s)",
        (list_id, message_ids),
    )
    return {message_id: thread_id for message_id, thread_id in cur.fetchall()}


def _last_known_reference(message_id: str, refs: list[str] | None, known_message_ids: set[str]) -> str | None:
    for ref in reversed(refs or []):
        if ref != message_id and ref in known_message_ids:
            return ref
    return None


def _effective_parent_id(
    message_id: str,
    record: dict,
    known_message_ids: set[str],
) -> str | None:
    parent_id = record.get("in_reply_to")
    if parent_id and parent_id != message_id and parent_id in known_message_ids:
        return parent_id
    return _last_known_reference(message_id, record.get("refs"), known_message_ids)


def _resolve_thread_ids(
    records: dict[str, dict],
    known_thread_ids: dict[str, str] | None = None,
) -> dict[str, str]:
    known_thread_ids = known_thread_ids or {}
    known_message_ids = set(records) | set(known_thread_ids)
    resolved: dict[str, str] = {}
    visiting: set[str] = set()

    def resolve(message_id: str) -> str:
        if message_id in resolved:
            return resolved[message_id]
        if message_id in visiting:
            return message_id

        record = records[message_id]
        visiting.add(message_id)
        refs = record.get("refs") or []
        parent_id = _effective_parent_id(message_id, record, known_message_ids)
        if parent_id:
            if parent_id in records:
                thread_id = resolve(parent_id)
            else:
                thread_id = known_thread_ids[parent_id]
        elif refs:
            thread_id = refs[0]
        else:
            thread_id = message_id
        visiting.remove(message_id)
        resolved[message_id] = thread_id
        return thread_id

    for message_id in records:
        resolve(message_id)

    return resolved


def _resolve_batch_thread_ids(conn, batch: list):
    if not batch:
        return

    list_id = batch[0]["list_id"]
    batch_records = {
        record["message_id"]: {
            "in_reply_to": record.get("in_reply_to"),
            "refs": record.get("refs"),
        }
        for record in batch
    }
    known_ids_to_fetch = set()
    for record in batch:
        parent_id = record.get("in_reply_to")
        if parent_id and parent_id not in batch_records:
            known_ids_to_fetch.add(parent_id)
        for ref in record.get("refs") or []:
            if ref not in batch_records:
                known_ids_to_fetch.add(ref)

    with conn.cursor() as cur:
        known_thread_ids = _fetch_thread_ids(cur, list_id, sorted(known_ids_to_fetch))

    resolved = _resolve_thread_ids(batch_records, known_thread_ids)
    for record in batch:
        record["thread_id"] = resolved[record["message_id"]]


def _message_sort_key(message_id: str, records: dict[str, dict]):
    sent_at = records[message_id].get("sent_at")
    return (sent_at is None, sent_at or datetime.max.replace(tzinfo=timezone.utc), message_id)


def _canonical_thread_ids_for_list(records: dict[str, dict]) -> dict[str, str]:
    if not records:
        return {}

    known_message_ids = set(records)
    parents: dict[str, str] = {}

    class UnionFind:
        def __init__(self, items: list[str]):
            self.parent = {item: item for item in items}

        def find(self, item: str) -> str:
            while self.parent[item] != item:
                self.parent[item] = self.parent[self.parent[item]]
                item = self.parent[item]
            return item

        def union(self, left: str, right: str):
            left_root = self.find(left)
            right_root = self.find(right)
            if left_root != right_root:
                self.parent[right_root] = left_root

    uf = UnionFind(list(records))
    for message_id, record in records.items():
        parent_id = _effective_parent_id(message_id, record, known_message_ids)
        if not parent_id:
            continue
        parents[message_id] = parent_id
        uf.union(message_id, parent_id)

    components: dict[str, list[str]] = {}
    for message_id in records:
        root = uf.find(message_id)
        components.setdefault(root, []).append(message_id)

    canonical: dict[str, str] = {}
    for members in components.values():
        member_set = set(members)
        root_candidates = [message_id for message_id in members if parents.get(message_id) not in member_set]
        candidates = root_candidates or members
        thread_id = min(candidates, key=lambda message_id: _message_sort_key(message_id, records))
        for message_id in members:
            canonical[message_id] = thread_id

    return canonical


def _insert_messages(cur, batch: list) -> dict[str, int]:
    """Insert a batch of messages and return DB ids for rows inserted in this batch."""
    if not batch:
        return {}

    rows = [tuple(record[column] for column in INSERT_MESSAGE_COLUMNS) for record in batch]
    inserted_rows = execute_values(
        cur,
        INSERT_MESSAGE_SQL,
        rows,
        template=INSERT_MESSAGE_TEMPLATE,
        page_size=500,
        fetch=True,
    )
    return {message_id: db_id for db_id, message_id in inserted_rows}


def _fetch_existing_message_ids(cur, batch: list) -> dict[str, int]:
    if not batch:
        return {}

    msg_ids = [record["message_id"] for record in batch]
    list_id = batch[0]["list_id"]
    cur.execute(
        "SELECT id, message_id FROM messages WHERE list_id = %s AND message_id = ANY(%s)",
        (list_id, msg_ids),
    )
    return {message_id: db_id for db_id, message_id in cur.fetchall()}


def _attachment_rows_for_batch(
    batch: list,
    id_map: dict[str, int],
    allowed_db_ids: set[int] | None = None,
) -> list[dict]:
    att_rows = []
    for record in batch:
        db_id = id_map.get(record["message_id"])
        if db_id is None:
            continue
        if allowed_db_ids is not None and db_id not in allowed_db_ids:
            continue
        for part_index, att in enumerate(record.get("_attachments", [])):
            att_rows.append({**att, "message_id": db_id, "part_index": part_index})
    return att_rows


def _insert_attachments(cur, batch: list, inserted_message_ids: dict[str, int] | None = None):
    """Insert attachments only for messages inserted in the current batch."""
    if inserted_message_ids is None:
        id_map = _fetch_existing_message_ids(cur, batch)
    else:
        id_map = inserted_message_ids

    att_rows = _attachment_rows_for_batch(batch, id_map)
    if att_rows:
        execute_batch(cur, INSERT_ATTACHMENT_SQL, att_rows, page_size=500)


def _replace_attachments(cur, batch: list) -> dict[str, int]:
    """Replace attachments for existing messages represented in the current batch."""
    id_map = _fetch_existing_message_ids(cur, batch)
    if not id_map:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    db_ids = sorted(set(id_map.values()))
    cur.execute(
        "SELECT DISTINCT message_id FROM attachments WHERE message_id = ANY(%s)",
        (db_ids,),
    )
    existing_attachment_ids = {message_id for (message_id,) in cur.fetchall()}

    target_db_ids = {
        db_id
        for record in batch
        if (db_id := id_map.get(record["message_id"])) is not None
        and (record.get("_attachments") or db_id in existing_attachment_ids)
    }
    if not target_db_ids:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    ordered_target_ids = sorted(target_db_ids)
    cur.execute(DELETE_ATTACHMENTS_SQL, (ordered_target_ids,))
    deleted_rows = cur.rowcount

    att_rows = _attachment_rows_for_batch(batch, id_map, target_db_ids)
    if att_rows:
        execute_batch(cur, INSERT_ATTACHMENT_SQL, att_rows, page_size=500)

    return {
        "attachments_deleted": deleted_rows,
        "attachments_inserted": len(att_rows),
        "messages_repaired": len(target_db_ids),
    }


def _refresh_threads_for_message_ids(cur, list_id: int, message_ids: list[str]):
    thread_ids = sorted(set(_fetch_thread_ids(cur, list_id, message_ids).values()))
    if not thread_ids:
        return
    cur.execute(UPSERT_TOUCHED_THREADS_SQL, (thread_ids,))


def store_batch_live(conn, batch: list):
    """Insert messages and refresh affected thread aggregates in one transaction."""
    if not batch:
        return

    _resolve_batch_thread_ids(conn, batch)
    list_id = batch[0]["list_id"]
    message_ids = [record["message_id"] for record in batch]
    with conn.cursor() as cur:
        inserted_message_ids = _insert_messages(cur, batch)
        _refresh_threads_for_message_ids(cur, list_id, message_ids)
        _insert_attachments(cur, batch, inserted_message_ids)
    conn.commit()


def store_batch_backfill(conn, batch: list):
    """Insert messages only; threads derived separately at the end."""
    _resolve_batch_thread_ids(conn, batch)
    with conn.cursor() as cur:
        inserted_message_ids = _insert_messages(cur, batch)
        _insert_attachments(cur, batch, inserted_message_ids)
    conn.commit()


def repair_batch_attachments(conn, batch: list) -> dict[str, int]:
    """Replace attachments for existing messages in a parsed batch."""
    if not batch:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    with conn.cursor() as cur:
        stats = _replace_attachments(cur, batch)
    conn.commit()
    return stats


def rethread_messages(conn):
    """Recompute messages.thread_id as canonical conversation IDs per list."""
    print("  [rethread messages]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("SELECT list_id, message_id, sent_at, in_reply_to, refs, thread_id FROM messages")
        rows = cur.fetchall()

    records_by_list: dict[int, dict[str, dict]] = {}
    current_thread_ids: dict[tuple[int, str], str] = {}
    for list_id, message_id, sent_at, in_reply_to, refs, thread_id in rows:
        records_by_list.setdefault(list_id, {})[message_id] = {
            "sent_at": sent_at,
            "in_reply_to": in_reply_to,
            "refs": refs,
        }
        current_thread_ids[(list_id, message_id)] = thread_id

    updates = []
    for list_id, records in records_by_list.items():
        canonical_thread_ids = _canonical_thread_ids_for_list(records)
        for message_id, thread_id in canonical_thread_ids.items():
            if current_thread_ids[(list_id, message_id)] != thread_id:
                updates.append({"message_id": message_id, "thread_id": thread_id})

    with conn.cursor() as cur:
        if updates:
            execute_batch(cur, UPDATE_MESSAGE_THREAD_SQL, updates, page_size=1000)
    conn.commit()
    print(f" {len(updates)} messages updated")


def decode_message_subjects(conn):
    """Decode stored RFC 2047 encoded-word subjects in messages."""
    print("  [decode subjects]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("SELECT message_id, subject FROM messages")
        rows = cur.fetchall()

    updates = []
    for message_id, subject in rows:
        decoded = _decode_subject(subject)
        if decoded != subject:
            updates.append({"message_id": message_id, "subject": decoded})

    with conn.cursor() as cur:
        if updates:
            execute_batch(cur, UPDATE_MESSAGE_SUBJECT_SQL, updates, page_size=1000)
    conn.commit()
    print(f" {len(updates)} messages updated")


def derive_threads(conn):
    """Rethread messages, then rebuild the derived threads table from messages."""
    rethread_messages(conn)
    print("  [derive threads]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("TRUNCATE threads")
        cur.execute(REBUILD_THREADS_SQL)
        count = cur.rowcount
    conn.commit()
    print(f" {count} threads rebuilt")


def refresh_analytics_views(conn):
    """Refresh analytics materialized views after archive data changes."""
    print("  [refresh analytics]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("SELECT refresh_analytics_views()")
    conn.commit()
    print(" done")


def _ingest_worker(dsn: str, list_id: int, year: int, month: int, list_name: str) -> int:
    """Parallel backfill worker — creates its own DB connection."""
    conn = psycopg2.connect(dsn)
    try:
        path = mbox_cache_path(year, month, list_name)
        print(f"\n=== {list_name}  {year:04d}-{month:02d} [backfill/parallel] ===")
        print(f"  [parse+store] {path.name}")
        batch: list = []
        total = 0
        for record in parse_mbox(path, list_id):
            batch.append(record)
            if len(batch) >= 500:
                store_batch_backfill(conn, batch)
                total += len(batch)
                batch = []
        if batch:
            store_batch_backfill(conn, batch)
            total += len(batch)
        print(f"  [done] {total} messages ingested ({list_name} {year:04d}-{month:02d})")
        return total
    finally:
        conn.close()


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
    refresh_analytics: bool = True,
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
        if refresh_analytics:
            refresh_analytics_views(conn)
    elif not backfill and refresh_analytics:
        refresh_analytics_views(conn)

    return total


def repair_attachments(
    conn,
    session: requests.Session,
    year: int,
    month: int,
    list_name: str = "pgsql-hackers",
    force_download: bool = False,
):
    print(f"\n=== {list_name}  {year:04d}-{month:02d} [repair attachments] ===")

    list_id = ensure_list(conn, session, year=year, month=month, list_name=list_name)
    try:
        path = download_mbox(session, year, month, list_name, force=force_download)
    except MonthNotFound as e:
        print(f"  [skip] {e}")
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
            "messages_scanned": 0,
        }

    print(f"  [parse+repair] {path.name}")
    batch: list = []
    stats = {
        "attachments_deleted": 0,
        "attachments_inserted": 0,
        "messages_repaired": 0,
        "messages_scanned": 0,
    }

    for record in parse_mbox(path, list_id):
        batch.append(record)
        if len(batch) >= 500:
            batch_stats = repair_batch_attachments(conn, batch)
            stats["attachments_deleted"] += batch_stats["attachments_deleted"]
            stats["attachments_inserted"] += batch_stats["attachments_inserted"]
            stats["messages_repaired"] += batch_stats["messages_repaired"]
            stats["messages_scanned"] += len(batch)
            print(f"    ...{stats['messages_scanned']} messages scanned", end="\r", flush=True)
            batch = []

    if batch:
        batch_stats = repair_batch_attachments(conn, batch)
        stats["attachments_deleted"] += batch_stats["attachments_deleted"]
        stats["attachments_inserted"] += batch_stats["attachments_inserted"]
        stats["messages_repaired"] += batch_stats["messages_repaired"]
        stats["messages_scanned"] += len(batch)

    print(
        "  [done] "
        f"{stats['messages_scanned']} messages scanned; "
        f"{stats['messages_repaired']} existing messages repaired; "
        f"{stats['attachments_deleted']} old attachments removed; "
        f"{stats['attachments_inserted']} attachments written"
    )
    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_year_month(value: str):
    try:
        y, m = value.split("-")
        return int(y), int(m)
    except ValueError:
        raise argparse.ArgumentTypeError(f"Expected YYYY-MM, got {value!r}")


def _load_list_names(args, parser: argparse.ArgumentParser) -> list[str]:
    list_names: list[str] = []

    for raw in args.list_names:
        for candidate in raw.replace(",", " ").split():
            if candidate:
                list_names.append(candidate)

    if args.lists_file:
        path = Path(args.lists_file)
        if not path.exists():
            parser.error(f"--lists-file not found: {args.lists_file}")
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            candidate = raw_line.split("#", 1)[0].strip()
            if candidate:
                list_names.append(candidate)

    if not list_names:
        env_many = os.environ.get("PGINBOX_LIST_NAMES", "")
        if env_many:
            list_names.extend([candidate for candidate in env_many.replace(",", " ").split() if candidate])

    if not list_names:
        env_one = os.environ.get("PGINBOX_LIST_NAME", "")
        if env_one:
            list_names.append(env_one)

    if not list_names:
        list_names.append(DEFAULT_LIST_NAME)

    # Preserve order while removing duplicates.
    seen = set()
    deduped: list[str] = []
    for name in list_names:
        if name in seen:
            continue
        seen.add(name)
        deduped.append(name)
    return deduped


def main():
    parser = argparse.ArgumentParser(description="Ingest PostgreSQL mailing list mbox archives")
    parser.add_argument("--list", dest="list_names", action="append", default=[],
                        help="List name to ingest (repeatable, supports comma-separated values)")
    parser.add_argument("--lists-file", default="",
                        help="Path to file with one list name per line (# comments supported)")
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
    parser.add_argument("--repair-attachments", action="store_true",
                        help="Reparse archives and replace attachments for existing messages")
    parser.add_argument("--delay", type=float, default=2.0,
                        help="Seconds to wait between downloads in range mode (default: 2)")
    parser.add_argument("--parallel", type=int, default=1, metavar="N",
                        help="Number of parallel workers for cache-only backfill (default: 1)")
    parser.add_argument("--derive-only", action="store_true",
                        help="Recompute canonical message thread IDs and rebuild the threads table")
    parser.add_argument("--decode-subjects", action="store_true",
                        help="Decode stored RFC 2047 message subjects and rebuild the threads table")

    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument("--year", type=int, help="Single month: year")
    mode.add_argument("--from", dest="from_ym", type=_parse_year_month,
                      metavar="YYYY-MM", help="Range start (inclusive)")

    parser.add_argument("--month", type=int, help="Single month: month (required with --year)")
    parser.add_argument("--to", dest="to_ym", type=_parse_year_month,
                        metavar="YYYY-MM", help="Range end (inclusive, required with --from)")

    args = parser.parse_args()
    list_names = _load_list_names(args, parser)

    if not args.derive_only and not args.decode_subjects and args.year is None and args.from_ym is None:
        parser.error("one of --derive-only, --decode-subjects, --year, or --from is required")

    # Validate single vs range args
    if args.year is not None and args.month is None:
        parser.error("--month is required with --year")
    if args.from_ym is not None and args.to_ym is None:
        parser.error("--to is required with --from")
    if args.derive_only and args.decode_subjects:
        parser.error("--derive-only cannot be combined with --decode-subjects")
    if args.derive_only and any(value is not None for value in (args.year, args.month, args.from_ym, args.to_ym)):
        parser.error("--derive-only cannot be combined with --year/--month/--from/--to")
    if args.decode_subjects and any(value is not None for value in (args.year, args.month, args.from_ym, args.to_ym)):
        parser.error("--decode-subjects cannot be combined with --year/--month/--from/--to")
    if args.repair_attachments and args.backfill:
        parser.error("--repair-attachments cannot be combined with --backfill")
    if args.repair_attachments and args.parallel != 1:
        parser.error("--repair-attachments cannot be combined with --parallel")

    if not args.dsn:
        print("Error: provide --dsn or set DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(args.dsn)
    if args.derive_only:
        derive_threads(conn)
        refresh_analytics_views(conn)
        conn.close()
        return
    if args.decode_subjects:
        decode_message_subjects(conn)
        derive_threads(conn)
        refresh_analytics_views(conn)
        conn.close()
        return

    # Build list of (year, month) to process
    if args.year is not None:
        months = [(args.year, args.month)]
    else:
        from_y, from_m = args.from_ym
        to_y, to_m = args.to_ym
        months = list(month_range(from_y, from_m, to_y, to_m))

    # Only auth if at least one month needs downloading across any requested list.
    needs_download_by_list = {
        list_name: (args.force_download or any(not is_cached(y, m, list_name) for y, m in months))
        for list_name in list_names
    }
    if any(needs_download_by_list.values()):
        if not args.pg_user or not args.pg_pass:
            print("Error: provide --pg-user/--pg-pass or set PG_LIST_USER/PG_LIST_PASS", file=sys.stderr)
            sys.exit(1)
        print("[auth] logging in to postgresql.org...")
        session = make_session(args.pg_user, args.pg_pass)
        for list_name in list_names:
            if not needs_download_by_list[list_name]:
                continue
            first_download_month = next(
                (y, m) for y, m in months if args.force_download or not is_cached(y, m, list_name)
            )
            ensure_archive_access(session, list_name, *first_download_month)
    else:
        session = requests.Session()

    grand_total = 0
    grand_attachment_stats = {
        "attachments_deleted": 0,
        "attachments_inserted": 0,
        "messages_repaired": 0,
        "messages_scanned": 0,
    }
    for list_idx, list_name in enumerate(list_names):
        needs_download = needs_download_by_list[list_name]
        use_parallel = (
            args.parallel > 1
            and args.backfill
            and not args.repair_attachments
            and not needs_download
            and len(months) > 1
        )

        list_total = 0
        if args.repair_attachments:
            list_stats = {
                "attachments_deleted": 0,
                "attachments_inserted": 0,
                "messages_repaired": 0,
                "messages_scanned": 0,
            }
            for i, (year, month) in enumerate(months):
                try:
                    month_stats = repair_attachments(
                        conn,
                        session,
                        year,
                        month,
                        list_name,
                        args.force_download,
                    )
                except ArchiveAuthError:
                    print("  [auth] archive access failed, re-authenticating and retrying once...")
                    session = make_session(args.pg_user, args.pg_pass)
                    ensure_archive_access(session, list_name, year, month)
                    month_stats = repair_attachments(
                        conn,
                        session,
                        year,
                        month,
                        list_name,
                        args.force_download,
                    )
                for key in list_stats:
                    list_stats[key] += month_stats[key]
                if i < len(months) - 1:
                    time.sleep(args.delay)

            grand_total += list_stats["messages_repaired"]
            for key in grand_attachment_stats:
                grand_attachment_stats[key] += list_stats[key]
            if len(list_names) > 1:
                print(
                    f"\n=== List total ({list_name}): "
                    f"{list_stats['messages_repaired']} messages repaired, "
                    f"{list_stats['attachments_inserted']} attachments written ==="
                )
        elif use_parallel:
            # Pre-register the list in the main thread so workers don't race on it
            list_id = ensure_list(conn, session, list_name, *months[0])
            print(f"\n[parallel] {list_name}: {len(months)} months, {args.parallel} workers")
            with ProcessPoolExecutor(max_workers=args.parallel) as executor:
                futures = {
                    executor.submit(_ingest_worker, args.dsn, list_id, y, m, list_name): (y, m)
                    for y, m in months
                }
                for future in as_completed(futures):
                    list_total += future.result()

            derive_threads(conn)
        else:
            for i, (year, month) in enumerate(months):
                # In range backfill mode, defer derive_threads until the final month.
                derive = not args.backfill or (i == len(months) - 1)
                try:
                    list_total += ingest(
                        conn, session, year, month,
                        list_name, args.force_download,
                        args.backfill, derive, False,
                    )
                except ArchiveAuthError:
                    print("  [auth] archive access failed, re-authenticating and retrying once...")
                    session = make_session(args.pg_user, args.pg_pass)
                    ensure_archive_access(session, list_name, year, month)
                    list_total += ingest(
                        conn, session, year, month,
                        list_name, args.force_download,
                        args.backfill, derive, False,
                    )
                if i < len(months) - 1:
                    time.sleep(args.delay)

        grand_total += list_total
        if not args.repair_attachments and len(list_names) > 1:
            print(f"\n=== List total ({list_name}): {list_total:,} messages ===")
        if list_idx < len(list_names) - 1:
            time.sleep(args.delay)

    if args.repair_attachments:
        print(
            f"\n=== Total: {grand_attachment_stats['messages_repaired']:,} messages repaired across "
            f"{len(list_names)} lists x {len(months)} months; "
            f"{grand_attachment_stats['attachments_inserted']:,} attachments written ==="
        )
    elif len(months) > 1 or len(list_names) > 1:
        print(
            f"\n=== Total: {grand_total:,} messages across "
            f"{len(list_names)} lists x {len(months)} months ==="
        )
    if not args.repair_attachments:
        refresh_analytics_views(conn)

    conn.close()


if __name__ == "__main__":
    main()
