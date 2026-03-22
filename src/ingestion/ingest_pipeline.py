from __future__ import annotations

from datetime import date
from pathlib import Path

import psycopg2
import requests

from src.ingestion.ingest_archive import (
    DEFAULT_LIST_NAME,
    MonthNotFound,
    download_mbox,
    ensure_list,
    mbox_cache_path,
)
from src.ingestion.ingest_parse import parse_mbox
from src.ingestion.ingest_store import (
    derive_threads,
    prune_missing_messages_for_archive_month,
    refresh_analytics_views,
    repair_batch_attachments,
    store_batch_backfill,
    store_batch_live,
    store_batch_overwrite,
)


def _ingest_worker(
    dsn: str,
    list_id: int,
    year: int,
    month: int,
    list_name: str,
    *,
    mbox_cache_path_fn=mbox_cache_path,
    parse_mbox_fn=parse_mbox,
    store_batch_backfill_fn=store_batch_backfill,
) -> int:
    """Parallel backfill worker — creates its own DB connection."""
    conn = psycopg2.connect(dsn)
    try:
        path = mbox_cache_path_fn(year, month, list_name)
        print(f"\n=== {list_name}  {year:04d}-{month:02d} [backfill/parallel] ===")
        print(f"  [parse+store] {path.name}")
        batch: list = []
        total = 0
        for record in parse_mbox_fn(path, list_id):
            batch.append(record)
            if len(batch) >= 500:
                store_batch_backfill_fn(conn, batch)
                total += len(batch)
                batch = []
        if batch:
            store_batch_backfill_fn(conn, batch)
            total += len(batch)
        print(
            f"  [done] {total} messages ingested ({list_name} {year:04d}-{month:02d})"
        )
        return total
    finally:
        conn.close()


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
    list_name: str = DEFAULT_LIST_NAME,
    force_download: bool = False,
    backfill: bool = False,
    overwrite_existing: bool = False,
    reconcile_existing: bool = False,
    derive: bool = True,
    refresh_analytics: bool = True,
    *,
    ensure_list_fn=ensure_list,
    download_mbox_fn=download_mbox,
    parse_mbox_fn=parse_mbox,
    store_batch_live_fn=store_batch_live,
    store_batch_backfill_fn=store_batch_backfill,
    store_batch_overwrite_fn=store_batch_overwrite,
    prune_missing_messages_for_archive_month_fn=prune_missing_messages_for_archive_month,
    derive_threads_fn=derive_threads,
    refresh_analytics_views_fn=refresh_analytics_views,
):
    if reconcile_existing:
        mode = "[reconcile]"
    elif overwrite_existing:
        mode = "[overwrite]"
    elif backfill:
        mode = "[backfill]"
    else:
        mode = "[live]"
    print(f"\n=== {list_name}  {year:04d}-{month:02d} {mode} ===")

    list_id = ensure_list_fn(conn, session, list_name, year, month)
    try:
        path = download_mbox_fn(session, year, month, list_name, force=force_download)
    except MonthNotFound as e:
        print(f"  [skip] {e}")
        return 0

    print(f"  [parse+store] {Path(path).name}")
    batch: list = []
    archive_month = date(year, month, 1)
    parsed_message_ids: set[str] = set()
    total = 0
    if reconcile_existing or overwrite_existing:
        store_batch = store_batch_overwrite_fn
    else:
        store_batch = store_batch_backfill_fn if backfill else store_batch_live_fn

    for record in parse_mbox_fn(path, list_id):
        parsed_message_ids.add(record["message_id"])
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

    if reconcile_existing:
        prune_stats = prune_missing_messages_for_archive_month_fn(
            conn,
            list_id=list_id,
            archive_month=archive_month,
            parsed_message_ids=parsed_message_ids,
        )
        print(
            "  [prune] "
            f"{prune_stats['messages_pruned']} messages removed; "
            f"{prune_stats['attachments_deleted']} attachments removed; "
            f"{prune_stats['tracking_rows_deleted']} tracking rows removed; "
            f"{prune_stats['progress_rows_deleted']} progress rows removed"
        )

    if (backfill or overwrite_existing or reconcile_existing) and derive:
        derive_threads_fn(conn, list_ids=[list_id])
        if refresh_analytics:
            refresh_analytics_views_fn(conn)
    elif not backfill and not overwrite_existing and not reconcile_existing and refresh_analytics:
        refresh_analytics_views_fn(conn)

    return total


def repair_attachments(
    conn,
    session: requests.Session,
    year: int,
    month: int,
    list_name: str = DEFAULT_LIST_NAME,
    force_download: bool = False,
    *,
    ensure_list_fn=ensure_list,
    download_mbox_fn=download_mbox,
    parse_mbox_fn=parse_mbox,
    repair_batch_attachments_fn=repair_batch_attachments,
):
    print(f"\n=== {list_name}  {year:04d}-{month:02d} [repair attachments] ===")

    list_id = ensure_list_fn(conn, session, year=year, month=month, list_name=list_name)
    try:
        path = download_mbox_fn(session, year, month, list_name, force=force_download)
    except MonthNotFound as e:
        print(f"  [skip] {e}")
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
            "messages_scanned": 0,
        }

    print(f"  [parse+repair] {Path(path).name}")
    batch: list = []
    stats = {
        "attachments_deleted": 0,
        "attachments_inserted": 0,
        "messages_repaired": 0,
        "messages_scanned": 0,
    }

    for record in parse_mbox_fn(path, list_id):
        batch.append(record)
        if len(batch) >= 500:
            batch_stats = repair_batch_attachments_fn(conn, batch)
            stats["attachments_deleted"] += batch_stats["attachments_deleted"]
            stats["attachments_inserted"] += batch_stats["attachments_inserted"]
            stats["messages_repaired"] += batch_stats["messages_repaired"]
            stats["messages_scanned"] += len(batch)
            print(
                f"    ...{stats['messages_scanned']} messages scanned",
                end="\r",
                flush=True,
            )
            batch = []

    if batch:
        batch_stats = repair_batch_attachments_fn(conn, batch)
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
