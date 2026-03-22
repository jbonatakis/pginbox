from datetime import datetime, timezone
from pathlib import Path


def ts(day: int) -> datetime:
    return datetime(2025, 1, day, tzinfo=timezone.utc)


def test_ingest_overwrite_defers_thread_rebuild_until_requested(ingest, monkeypatch):
    events = []

    def fake_ensure_list(conn, session, list_name, year, month):
        events.append(("ensure_list", list_name, year, month))
        return 23

    def fake_download_mbox(session, year, month, list_name, force=False):
        events.append(("download_mbox", year, month, list_name, force))
        return Path(f"/tmp/{list_name}.{year:04d}{month:02d}")

    def fake_parse_mbox(path, list_id):
        events.append(("parse_mbox", str(path), list_id))
        yield {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": list_id,
            "archive_month": datetime(2026, 3, 1, tzinfo=timezone.utc).date(),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "Sender",
            "from_email": "sender@example.com",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [],
            "_normalized_subject": "Subject",
        }

    def fake_store_batch_overwrite(conn, batch):
        events.append(
            ("store_batch_overwrite", [record["message_id"] for record in batch])
        )

    def fake_derive_threads(conn, list_ids=None):
        events.append(("derive_threads", list_ids))

    def fake_refresh_analytics_views(conn):
        events.append(("refresh_analytics_views",))

    monkeypatch.setattr(ingest, "ensure_list", fake_ensure_list)
    monkeypatch.setattr(ingest, "download_mbox", fake_download_mbox)
    monkeypatch.setattr(ingest, "parse_mbox", fake_parse_mbox)
    monkeypatch.setattr(ingest, "store_batch_overwrite", fake_store_batch_overwrite)
    monkeypatch.setattr(ingest, "derive_threads", fake_derive_threads)
    monkeypatch.setattr(ingest, "refresh_analytics_views", fake_refresh_analytics_views)

    total = ingest.ingest(
        conn=object(),
        session=object(),
        year=2026,
        month=3,
        list_name="pgsql-hackers",
        overwrite_existing=True,
        derive=True,
        refresh_analytics=False,
    )

    assert total == 1
    assert events == [
        ("ensure_list", "pgsql-hackers", 2026, 3),
        ("download_mbox", 2026, 3, "pgsql-hackers", False),
        ("parse_mbox", "/tmp/pgsql-hackers.202603", 23),
        ("store_batch_overwrite", ["<message@example.com>"]),
        ("derive_threads", [23]),
    ]


def test_ingest_reconcile_prunes_missing_rows_and_derives_scoped_list(
    ingest, monkeypatch
):
    events = []

    def fake_ensure_list(conn, session, list_name, year, month):
        events.append(("ensure_list", list_name, year, month))
        return 23

    def fake_download_mbox(session, year, month, list_name, force=False):
        events.append(("download_mbox", year, month, list_name, force))
        return Path(f"/tmp/{list_name}.{year:04d}{month:02d}")

    def fake_parse_mbox(path, list_id):
        events.append(("parse_mbox", str(path), list_id))
        yield {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": list_id,
            "archive_month": datetime(2026, 3, 1, tzinfo=timezone.utc).date(),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "Sender",
            "from_email": "sender@example.com",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [],
            "_normalized_subject": "Subject",
        }

    def fake_store_batch_overwrite(conn, batch):
        events.append(
            ("store_batch_overwrite", [record["message_id"] for record in batch])
        )

    def fake_prune(conn, *, list_id, archive_month, parsed_message_ids):
        events.append(("prune", list_id, archive_month, parsed_message_ids))
        return {
            "messages_pruned": 2,
            "attachments_deleted": 4,
            "tracking_rows_deleted": 1,
            "progress_rows_deleted": 1,
            "legacy_follow_rows_deleted": 0,
        }

    def fake_derive_threads(conn, list_ids=None):
        events.append(("derive_threads", list_ids))

    monkeypatch.setattr(ingest, "ensure_list", fake_ensure_list)
    monkeypatch.setattr(ingest, "download_mbox", fake_download_mbox)
    monkeypatch.setattr(ingest, "parse_mbox", fake_parse_mbox)
    monkeypatch.setattr(ingest, "store_batch_overwrite", fake_store_batch_overwrite)
    monkeypatch.setattr(
        ingest,
        "prune_missing_messages_for_archive_month",
        fake_prune,
    )
    monkeypatch.setattr(ingest, "derive_threads", fake_derive_threads)

    total = ingest.ingest(
        conn=object(),
        session=object(),
        year=2026,
        month=3,
        list_name="pgsql-hackers",
        reconcile_existing=True,
        derive=True,
        refresh_analytics=False,
    )

    assert total == 1
    assert events == [
        ("ensure_list", "pgsql-hackers", 2026, 3),
        ("download_mbox", 2026, 3, "pgsql-hackers", False),
        ("parse_mbox", "/tmp/pgsql-hackers.202603", 23),
        ("store_batch_overwrite", ["<message@example.com>"]),
        (
            "prune",
            23,
            datetime(2026, 3, 1, tzinfo=timezone.utc).date(),
            {"<message@example.com>"},
        ),
        ("derive_threads", [23]),
    ]


def test_main_derive_only_skip_analytics_suppresses_refresh(ingest, monkeypatch):
    events = []

    class FakeConn:
        def close(self):
            events.append(("close",))

    monkeypatch.setattr(ingest.psycopg2, "connect", lambda dsn: FakeConn())
    monkeypatch.setattr(
        ingest,
        "derive_threads",
        lambda conn, list_ids=None: events.append(("derive_threads", list_ids)),
    )
    monkeypatch.setattr(
        ingest,
        "refresh_analytics_views",
        lambda conn: events.append(("refresh_analytics_views",)),
    )
    monkeypatch.setattr(
        ingest.sys,
        "argv",
        [
            "ingest.py",
            "--dsn",
            "postgresql://example",
            "--derive-only",
            "--skip-analytics",
        ],
    )

    ingest.main()

    assert events == [
        ("derive_threads", None),
        ("close",),
    ]


def test_main_retries_archive_access_preflight_with_reauth(ingest, monkeypatch):
    events = []
    sleeps = []

    class FakeConn:
        def close(self):
            events.append(("close",))

    session_counter = {"value": 0}

    def fake_make_session(username, password):
        session_counter["value"] += 1
        session = f"session-{session_counter['value']}"
        events.append(("make_session", username, password, session))
        return session

    def fake_ensure_archive_access(session, list_name, year, month):
        events.append(("ensure_archive_access", session, list_name, year, month))
        if session == "session-1":
            raise ingest.ArchiveAuthError("Authentication token too old")

    def fake_ingest(
        conn,
        session,
        year,
        month,
        list_name,
        force_download=False,
        backfill=False,
        overwrite_existing=False,
        reconcile_existing=False,
        derive=True,
        refresh_analytics=True,
    ):
        events.append(
            (
                "ingest",
                session,
                year,
                month,
                list_name,
                force_download,
                overwrite_existing,
            )
        )
        return 0

    monkeypatch.setattr(ingest.psycopg2, "connect", lambda dsn: FakeConn())
    monkeypatch.setattr(ingest, "is_cached", lambda year, month, list_name: False)
    monkeypatch.setattr(ingest, "make_session", fake_make_session)
    monkeypatch.setattr(ingest, "ensure_archive_access", fake_ensure_archive_access)
    monkeypatch.setattr(ingest, "ingest", fake_ingest)
    monkeypatch.setattr(ingest.time, "sleep", lambda delay: sleeps.append(delay))
    monkeypatch.setattr(
        ingest.sys,
        "argv",
        [
            "ingest.py",
            "--dsn",
            "postgresql://example",
            "--pg-user",
            "user",
            "--pg-pass",
            "pass",
            "--skip-analytics",
            "--list",
            "pgsql-hackers",
            "--year",
            "2026",
            "--month",
            "3",
        ],
    )

    ingest.main()

    assert sleeps == [1.0]
    assert events == [
        ("make_session", "user", "pass", "session-1"),
        ("ensure_archive_access", "session-1", "pgsql-hackers", 2026, 3),
        ("make_session", "user", "pass", "session-2"),
        ("ensure_archive_access", "session-2", "pgsql-hackers", 2026, 3),
        ("ingest", "session-2", 2026, 3, "pgsql-hackers", False, False),
        ("close",),
    ]
