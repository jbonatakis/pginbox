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

    def fake_derive_threads(conn):
        events.append(("derive_threads",))

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
        ("derive_threads",),
    ]
