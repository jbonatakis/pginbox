from __future__ import annotations

import gzip
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests


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
DEFAULT_LIST_NAME = "pgsql-hackers"


def mbox_cache_path(year: int, month: int, list_name: str) -> Path:
    return CACHE_DIR / f"{list_name}.{year:04d}{month:02d}.gz"


def is_cached(year: int, month: int, list_name: str) -> bool:
    p = mbox_cache_path(year, month, list_name)
    return p.exists() and p.stat().st_size > 0


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
    login_resp = session.post(
        LOGIN_URL, data=payload, headers={"Referer": LOGIN_URL}, timeout=30
    )
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
        raise RuntimeError(
            f"Failed to open archive URL after retries: {auth_url}"
        ) from last_error

    content_type = resp.headers.get("content-type", "")
    if "text/html" in content_type and any(
        marker in resp.url
        for marker in ("/account/login", "/list/_auth/accounts/login", "/account/auth/")
    ):
        resp.close()
        raise ArchiveAuthError(
            f"Archive authentication failed or expired. Final URL: {resp.url}"
        )

    return resp


def ensure_archive_access(
    session: requests.Session, list_name: str, year: int, month: int
):
    """Verify the current session can access archive data without auth redirects."""
    year_month = f"{year:04d}{month:02d}"
    url = BASE_URL.format(list_name=list_name, year_month=year_month)
    with _open_archive_response(session, url, timeout=30) as resp:
        if "text/html" in resp.headers.get("content-type", ""):
            raise ArchiveAuthError(
                f"Archive access returned HTML instead of mbox. URL: {resp.url}"
            )


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


def ensure_list(
    conn, session: requests.Session, list_name: str, year: int, month: int
) -> int:
    """Return the list_id for list_name, registering it if this is the first time we've seen it.

    Validation (probing the mbox URL) is skipped when the file is already cached,
    since a successful prior download is proof enough the list exists.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM lists WHERE name = %s", (list_name,))
        row = cur.fetchone()
        if row:
            return row[0]

    if not is_cached(year, month, list_name):
        _validate_list(session, list_name, year, month)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO lists (name) VALUES (%s) ON CONFLICT (name) DO NOTHING RETURNING id",
            (list_name,),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute("SELECT id FROM lists WHERE name = %s", (list_name,))
            row = cur.fetchone()
        list_id = row[0]
    conn.commit()
    print(f"  [list] '{list_name}' registered (id={list_id})")
    return list_id


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
    out_path = mbox_cache_path(year, month, list_name)

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
            with gzip.open(tmp_path, "wb") as f:
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
            raise MonthNotFound(
                f"No mbox found for {list_name} {year_month} (empty response)"
            )
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    tmp_path.rename(out_path)
    size_mb = out_path.stat().st_size / 1e6
    print(f"  [saved] {out_path} ({size_mb:.1f} MB)")
    return out_path
