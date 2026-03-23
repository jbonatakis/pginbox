#!/usr/bin/env python3
"""
POC: Download, parse, and store PostgreSQL mailing list mbox archives into Postgres.

Usage:
    # Live (inserts messages, refreshes affected threads):
    python3 ingest.py --year 2026 --month 2

    # Live without refreshing analytics materialized views:
    python3 ingest.py --year 2026 --month 2 --skip-analytics

    # Backfill (bulk insert messages, derive threads at the end):
    python3 ingest.py --year 2026 --month 2 --backfill

    # Reparse a month and overwrite existing message rows + attachments:
    python3 ingest.py --year 2026 --month 2 --overwrite-existing

    # Reparse a month and prune rows no longer present in the archive:
    python3 ingest.py --year 2026 --month 2 --reconcile-existing

    # Rebuild canonical message.thread_id values and the derived threads table:
    python3 ingest.py --derive-only

    # Decode stored RFC 2047 message subjects and rebuild threads:
    python3 ingest.py --decode-subjects

    Credentials via --pg-user/--pg-pass or PG_LIST_USER/PG_LIST_PASS env vars.
    DB via --dsn or DATABASE_URL env var.
"""

import argparse
import importlib
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_batch
import requests
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

PACKAGE_NAME = __package__ or "src.ingestion"
ingest_archive = importlib.import_module(f"{PACKAGE_NAME}.ingest_archive")
ingest_parse = importlib.import_module(f"{PACKAGE_NAME}.ingest_parse")
pipeline_lib = importlib.import_module(f"{PACKAGE_NAME}.ingest_pipeline")
store_lib = importlib.import_module(f"{PACKAGE_NAME}.ingest_store")

ArchiveAuthError = ingest_archive.ArchiveAuthError
DEFAULT_LIST_NAME = ingest_archive.DEFAULT_LIST_NAME
MonthNotFound = ingest_archive.MonthNotFound
download_mbox = ingest_archive.download_mbox
ensure_archive_access = ingest_archive.ensure_archive_access
ensure_list = ingest_archive.ensure_list
is_cached = ingest_archive.is_cached
make_session = ingest_archive.make_session
mbox_cache_path = ingest_archive.mbox_cache_path

_decode_subject = ingest_parse._decode_subject
_extract_message_id = ingest_parse._extract_message_id
_extract_message_ids = ingest_parse._extract_message_ids
_normalize_email = ingest_parse._normalize_email
_normalize_subject = ingest_parse._normalize_subject
_strip_nul = ingest_parse._strip_nul
parse_mbox = ingest_parse.parse_mbox

load_dotenv()

ARCHIVE_AUTH_MAX_ATTEMPTS = 3
ARCHIVE_AUTH_RETRY_BASE_DELAY = 1.0


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

UPSERT_TOUCHED_THREADS_SQL = store_lib.UPSERT_TOUCHED_THREADS_SQL
INSERT_MESSAGE_COLUMNS = store_lib.INSERT_MESSAGE_COLUMNS
INSERT_MESSAGE_SQL = store_lib.INSERT_MESSAGE_SQL
INSERT_MESSAGE_TEMPLATE = store_lib.INSERT_MESSAGE_TEMPLATE
OVERWRITE_MESSAGE_SQL = store_lib.OVERWRITE_MESSAGE_SQL
INSERT_ATTACHMENT_SQL = store_lib.INSERT_ATTACHMENT_SQL
DELETE_ATTACHMENTS_SQL = store_lib.DELETE_ATTACHMENTS_SQL
UPDATE_MESSAGE_THREAD_SQL = store_lib.UPDATE_MESSAGE_THREAD_SQL
UPDATE_MESSAGE_SUBJECT_SQL = store_lib.UPDATE_MESSAGE_SUBJECT_SQL
REBUILD_THREADS_SQL = store_lib.REBUILD_THREADS_SQL

_last_known_reference = store_lib._last_known_reference
_effective_parent_id = store_lib._effective_parent_id
_resolve_thread_ids = store_lib._resolve_thread_ids
_message_sort_key = store_lib._message_sort_key
_canonical_thread_ids_for_list = store_lib._canonical_thread_ids_for_list
month_range = pipeline_lib.month_range
_ingest_worker = pipeline_lib._ingest_worker


def _fetch_thread_ids(cur, list_id: int, message_ids: list[str]) -> dict[str, str]:
    return store_lib._fetch_thread_ids(cur, list_id, message_ids)


def _resolve_batch_thread_ids(conn, batch: list):
    return store_lib._resolve_batch_thread_ids(
        conn,
        batch,
        fetch_thread_ids=_fetch_thread_ids,
    )


def _insert_messages(cur, batch: list) -> dict[str, int]:
    return store_lib._insert_messages(cur, batch)


def _update_messages(cur, batch: list) -> dict[str, int]:
    return store_lib._update_messages(cur, batch)


def _fetch_existing_message_ids(cur, batch: list) -> dict[str, int]:
    return store_lib._fetch_existing_message_ids(cur, batch)


def _attachment_rows_for_batch(
    batch: list,
    id_map: dict[str, int],
    allowed_db_ids: set[int] | None = None,
) -> list[dict]:
    return store_lib._attachment_rows_for_batch(batch, id_map, allowed_db_ids)


def _insert_attachments(
    cur, batch: list, inserted_message_ids: dict[str, int] | None = None
):
    return store_lib._insert_attachments(
        cur,
        batch,
        inserted_message_ids,
        fetch_existing_message_ids=_fetch_existing_message_ids,
        attachment_rows_for_batch=_attachment_rows_for_batch,
        execute_batch_fn=execute_batch,
        insert_attachment_sql=INSERT_ATTACHMENT_SQL,
    )


def _replace_attachments_for_ids(
    cur,
    batch: list,
    id_map: dict[str, int],
    target_db_ids: set[int] | None = None,
) -> dict[str, int]:
    return store_lib._replace_attachments_for_ids(
        cur,
        batch,
        id_map,
        target_db_ids,
        attachment_rows_for_batch=_attachment_rows_for_batch,
        execute_batch_fn=execute_batch,
        delete_attachments_sql=DELETE_ATTACHMENTS_SQL,
        insert_attachment_sql=INSERT_ATTACHMENT_SQL,
    )


def _replace_attachments(cur, batch: list) -> dict[str, int]:
    return store_lib._replace_attachments(
        cur,
        batch,
        fetch_existing_message_ids=_fetch_existing_message_ids,
        replace_attachments_for_ids=_replace_attachments_for_ids,
    )


def _overwrite_messages(cur, batch: list) -> dict[str, int]:
    return store_lib._overwrite_messages(
        cur,
        batch,
        fetch_existing_message_ids=_fetch_existing_message_ids,
        update_messages=_update_messages,
        insert_messages=_insert_messages,
    )


def _refresh_threads_for_message_ids(
    cur,
    list_id: int,
    message_ids: list[str],
    *,
    fetch_thread_aggregates=store_lib._fetch_thread_aggregates,
    resolve_stable_thread_ids=store_lib._resolve_stable_thread_ids,
    upsert_thread_rows=store_lib._upsert_thread_rows,
):
    return store_lib._refresh_threads_for_message_ids(
        cur,
        list_id,
        message_ids,
        fetch_thread_ids=_fetch_thread_ids,
        fetch_thread_aggregates=fetch_thread_aggregates,
        resolve_stable_thread_ids=resolve_stable_thread_ids,
        upsert_thread_rows=upsert_thread_rows,
    )


def _auto_track_participation_for_inserted_messages(
    cur,
    inserted_message_ids: dict[str, int],
):
    return store_lib._auto_track_participation_for_inserted_messages(
        cur,
        inserted_message_ids,
    )


def store_batch_live(conn, batch: list):
    return store_lib.store_batch_live(
        conn,
        batch,
        resolve_batch_thread_ids=_resolve_batch_thread_ids,
        insert_messages=_insert_messages,
        refresh_threads_for_message_ids=_refresh_threads_for_message_ids,
        auto_track_participation_for_inserted_messages=_auto_track_participation_for_inserted_messages,
        insert_attachments=_insert_attachments,
    )


def store_batch_backfill(conn, batch: list):
    return store_lib.store_batch_backfill(
        conn,
        batch,
        resolve_batch_thread_ids=_resolve_batch_thread_ids,
        insert_messages=_insert_messages,
        insert_attachments=_insert_attachments,
    )


def store_batch_overwrite(conn, batch: list):
    return store_lib.store_batch_overwrite(
        conn,
        batch,
        resolve_batch_thread_ids=_resolve_batch_thread_ids,
        overwrite_messages=_overwrite_messages,
        replace_attachments_for_ids=_replace_attachments_for_ids,
    )


def prune_missing_messages_for_archive_month(
    conn,
    *,
    list_id: int,
    archive_month,
    parsed_message_ids: set[str],
) -> dict[str, int]:
    return store_lib.prune_missing_messages_for_archive_month(
        conn,
        list_id=list_id,
        archive_month=archive_month,
        parsed_message_ids=parsed_message_ids,
    )


def repair_batch_attachments(conn, batch: list) -> dict[str, int]:
    return store_lib.repair_batch_attachments(
        conn,
        batch,
        replace_attachments=_replace_attachments,
    )


def rethread_messages(conn, *, list_ids: list[int] | None = None):
    return store_lib.rethread_messages(conn, list_ids=list_ids)


def decode_message_subjects(conn):
    return store_lib.decode_message_subjects(
        conn,
        decode_subject=_decode_subject,
        execute_batch_fn=execute_batch,
        update_message_subject_sql=UPDATE_MESSAGE_SUBJECT_SQL,
    )


def derive_threads(conn, *, list_ids: list[int] | None = None):
    return store_lib.derive_threads(
        conn,
        list_ids=list_ids,
    )


def refresh_analytics_views(conn):
    return store_lib.refresh_analytics_views(conn)


def _ensure_archive_access_with_reauth(
    session: requests.Session,
    list_name: str,
    year: int,
    month: int,
    pg_user: str,
    pg_pass: str,
    *,
    max_attempts: int = ARCHIVE_AUTH_MAX_ATTEMPTS,
    retry_base_delay: float = ARCHIVE_AUTH_RETRY_BASE_DELAY,
    make_session_fn=None,
    ensure_archive_access_fn=None,
    sleep_fn=None,
) -> requests.Session:
    make_session_fn = make_session if make_session_fn is None else make_session_fn
    ensure_archive_access_fn = (
        ensure_archive_access if ensure_archive_access_fn is None else ensure_archive_access_fn
    )
    sleep_fn = time.sleep if sleep_fn is None else sleep_fn

    for attempt in range(1, max_attempts + 1):
        try:
            ensure_archive_access_fn(session, list_name, year, month)
            return session
        except ArchiveAuthError:
            if attempt >= max_attempts:
                raise
            delay = retry_base_delay * (2 ** (attempt - 1))
            print(
                "  [auth] archive access failed, re-authenticating and retrying "
                f"in {delay:.1f}s ({attempt}/{max_attempts - 1})..."
            )
            sleep_fn(delay)
            session = make_session_fn(pg_user, pg_pass)

    return session


def ingest(
    conn,
    session: requests.Session,
    year: int,
    month: int,
    list_name: str = DEFAULT_LIST_NAME,
    force_download: bool = False,
    backfill: bool = False,
    overwrite_existing: bool = False,
    reconcile_existing: bool = False,
    derive: bool = True,
    refresh_analytics: bool = True,
):
    return pipeline_lib.ingest(
        conn,
        session,
        year,
        month,
        list_name,
        force_download,
        backfill,
        overwrite_existing,
        reconcile_existing,
        derive,
        refresh_analytics,
        ensure_list_fn=ensure_list,
        download_mbox_fn=download_mbox,
        parse_mbox_fn=parse_mbox,
        store_batch_live_fn=store_batch_live,
        store_batch_backfill_fn=store_batch_backfill,
        store_batch_overwrite_fn=store_batch_overwrite,
        prune_missing_messages_for_archive_month_fn=prune_missing_messages_for_archive_month,
        derive_threads_fn=derive_threads,
        refresh_analytics_views_fn=refresh_analytics_views,
    )


def repair_attachments(
    conn,
    session: requests.Session,
    year: int,
    month: int,
    list_name: str = DEFAULT_LIST_NAME,
    force_download: bool = False,
):
    return pipeline_lib.repair_attachments(
        conn,
        session,
        year,
        month,
        list_name,
        force_download,
        ensure_list_fn=ensure_list,
        download_mbox_fn=download_mbox,
        parse_mbox_fn=parse_mbox,
        repair_batch_attachments_fn=repair_batch_attachments,
    )


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
            list_names.extend(
                [
                    candidate
                    for candidate in env_many.replace(",", " ").split()
                    if candidate
                ]
            )

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


def _lookup_existing_list_ids(conn, list_names: list[str]) -> list[int]:
    if not list_names:
        return []

    with conn.cursor() as cur:
        cur.execute(
            "SELECT name, id FROM lists WHERE name = ANY(%s)",
            (list_names,),
        )
        rows = cur.fetchall()

    ids_by_name = {name: list_id for name, list_id in rows}
    missing = [name for name in list_names if name not in ids_by_name]
    if missing:
        missing_csv = ", ".join(missing)
        raise ValueError(f"--derive-only list not found in database: {missing_csv}")

    return [ids_by_name[name] for name in list_names]


def main():
    parser = argparse.ArgumentParser(
        description="Ingest PostgreSQL mailing list mbox archives"
    )
    parser.add_argument(
        "--list",
        dest="list_names",
        action="append",
        default=[],
        help="List name to ingest (repeatable, supports comma-separated values)",
    )
    parser.add_argument(
        "--lists-file",
        default="",
        help="Path to file with one list name per line (# comments supported)",
    )
    parser.add_argument(
        "--dsn",
        default=os.environ.get("DATABASE_URL", ""),
        help="Postgres DSN (or set DATABASE_URL)",
    )
    parser.add_argument(
        "--pg-user",
        default=os.environ.get("PG_LIST_USER", ""),
        help="postgresql.org account username (or set PG_LIST_USER)",
    )
    parser.add_argument(
        "--pg-pass",
        default=os.environ.get("PG_LIST_PASS", ""),
        help="postgresql.org account password (or set PG_LIST_PASS)",
    )
    parser.add_argument(
        "--force-download", action="store_true", help="Re-download even if cached"
    )
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Bulk insert messages, derive threads at end (faster for historical data)",
    )
    parser.add_argument(
        "--overwrite-existing",
        action="store_true",
        help="Reparse archives and overwrite existing messages plus attachments in place",
    )
    parser.add_argument(
        "--reconcile-existing",
        action="store_true",
        help=(
            "Reparse archives, overwrite current rows, and prune rows no longer "
            "present in the reparsed archive month"
        ),
    )
    parser.add_argument(
        "--repair-attachments",
        action="store_true",
        help="Reparse archives and replace attachments for existing messages",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=2.0,
        help="Seconds to wait between downloads in range mode (default: 2)",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        metavar="N",
        help="Number of parallel workers for cache-only backfill (default: 1)",
    )
    parser.add_argument(
        "--derive-only",
        action="store_true",
        help="Recompute canonical message thread IDs and rebuild the threads table",
    )
    parser.add_argument(
        "--decode-subjects",
        action="store_true",
        help="Decode stored RFC 2047 message subjects and rebuild the threads table",
    )
    parser.add_argument(
        "--skip-analytics",
        action="store_true",
        help="Skip refreshing analytics materialized views after ingest/derive work",
    )

    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument("--year", type=int, help="Single month: year")
    mode.add_argument(
        "--from",
        dest="from_ym",
        type=_parse_year_month,
        metavar="YYYY-MM",
        help="Range start (inclusive)",
    )

    parser.add_argument(
        "--month", type=int, help="Single month: month (required with --year)"
    )
    parser.add_argument(
        "--to",
        dest="to_ym",
        type=_parse_year_month,
        metavar="YYYY-MM",
        help="Range end (inclusive, required with --from)",
    )

    args = parser.parse_args()
    list_names = _load_list_names(args, parser)

    if (
        not args.derive_only
        and not args.decode_subjects
        and args.year is None
        and args.from_ym is None
    ):
        parser.error(
            "one of --derive-only, --decode-subjects, --year, or --from is required"
        )

    # Validate single vs range args
    if args.year is not None and args.month is None:
        parser.error("--month is required with --year")
    if args.from_ym is not None and args.to_ym is None:
        parser.error("--to is required with --from")
    if args.derive_only and args.decode_subjects:
        parser.error("--derive-only cannot be combined with --decode-subjects")
    if args.derive_only and any(
        value is not None for value in (args.year, args.month, args.from_ym, args.to_ym)
    ):
        parser.error("--derive-only cannot be combined with --year/--month/--from/--to")
    if args.decode_subjects and any(
        value is not None for value in (args.year, args.month, args.from_ym, args.to_ym)
    ):
        parser.error(
            "--decode-subjects cannot be combined with --year/--month/--from/--to"
        )
    if args.repair_attachments and args.backfill:
        parser.error("--repair-attachments cannot be combined with --backfill")
    if args.repair_attachments and args.overwrite_existing:
        parser.error(
            "--repair-attachments cannot be combined with --overwrite-existing"
        )
    if args.repair_attachments and args.reconcile_existing:
        parser.error(
            "--repair-attachments cannot be combined with --reconcile-existing"
        )
    if args.overwrite_existing and args.reconcile_existing:
        parser.error(
            "--overwrite-existing cannot be combined with --reconcile-existing"
        )
    if args.reconcile_existing and args.backfill:
        parser.error("--reconcile-existing cannot be combined with --backfill")
    if args.repair_attachments and args.parallel != 1:
        parser.error("--repair-attachments cannot be combined with --parallel")
    if args.overwrite_existing and args.parallel != 1:
        parser.error("--overwrite-existing cannot be combined with --parallel")
    if args.reconcile_existing and args.parallel != 1:
        parser.error("--reconcile-existing cannot be combined with --parallel")

    if not args.dsn:
        print("Error: provide --dsn or set DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(args.dsn)
    if args.derive_only:
        derive_list_ids = None
        if args.list_names or args.lists_file:
            try:
                derive_list_ids = _lookup_existing_list_ids(conn, list_names)
            except ValueError as exc:
                parser.error(str(exc))
        derive_threads(conn, list_ids=derive_list_ids)
        if not args.skip_analytics:
            refresh_analytics_views(conn)
        conn.close()
        return
    if args.decode_subjects:
        decode_message_subjects(conn)
        derive_threads(conn)
        if not args.skip_analytics:
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
        list_name: (
            args.force_download
            or any(not is_cached(y, m, list_name) for y, m in months)
        )
        for list_name in list_names
    }
    if any(needs_download_by_list.values()):
        if not args.pg_user or not args.pg_pass:
            print(
                "Error: provide --pg-user/--pg-pass or set PG_LIST_USER/PG_LIST_PASS",
                file=sys.stderr,
            )
            sys.exit(1)
        print("[auth] logging in to postgresql.org...")
        session = make_session(args.pg_user, args.pg_pass)
        for list_name in list_names:
            if not needs_download_by_list[list_name]:
                continue
            first_download_month = next(
                (y, m)
                for y, m in months
                if args.force_download or not is_cached(y, m, list_name)
            )
            session = _ensure_archive_access_with_reauth(
                session,
                list_name,
                *first_download_month,
                args.pg_user,
                args.pg_pass,
            )
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
            and not args.overwrite_existing
            and not args.reconcile_existing
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
                    session = _ensure_archive_access_with_reauth(
                        session,
                        list_name,
                        year,
                        month,
                        args.pg_user,
                        args.pg_pass,
                    )
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
            print(
                f"\n[parallel] {list_name}: {len(months)} months, {args.parallel} workers"
            )
            with ProcessPoolExecutor(max_workers=args.parallel) as executor:
                futures = {
                    executor.submit(
                        _ingest_worker, args.dsn, list_id, y, m, list_name
                    ): (y, m)
                    for y, m in months
                }
                for future in as_completed(futures):
                    list_total += future.result()

            derive_threads(conn, list_ids=[list_id])
        else:
            for i, (year, month) in enumerate(months):
                # For backfill/overwrite/reconcile modes, defer thread rebuild until the final month.
                derive = (
                    not args.backfill
                    and not args.overwrite_existing
                    and not args.reconcile_existing
                ) or (i == len(months) - 1)
                try:
                    list_total += ingest(
                        conn,
                        session,
                        year,
                        month,
                        list_name,
                        args.force_download,
                        args.backfill,
                        args.overwrite_existing,
                        args.reconcile_existing,
                        derive,
                        False,
                    )
                except ArchiveAuthError:
                    session = _ensure_archive_access_with_reauth(
                        session,
                        list_name,
                        year,
                        month,
                        args.pg_user,
                        args.pg_pass,
                    )
                    list_total += ingest(
                        conn,
                        session,
                        year,
                        month,
                        list_name,
                        args.force_download,
                        args.backfill,
                        args.overwrite_existing,
                        args.reconcile_existing,
                        derive,
                        False,
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
    if not args.repair_attachments and not args.skip_analytics:
        refresh_analytics_views(conn)

    conn.close()


if __name__ == "__main__":
    main()
