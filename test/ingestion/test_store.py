from datetime import datetime, timezone
from typing import Any


def ts(day: int) -> datetime:
    return datetime(2025, 1, day, tzinfo=timezone.utc)


def test_store_batch_live_refreshes_threads_after_message_insert(ingest, monkeypatch):
    events = []

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()

        def cursor(self):
            return self._cursor

        def commit(self):
            events.append(("commit",))

    batch = [
        {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "",
            "from_email": "",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [],
            "_normalized_subject": "Subject",
        }
    ]

    def fake_resolve_batch_thread_ids(conn, pending_batch):
        events.append(("resolve", [record["message_id"] for record in pending_batch]))

    def fake_insert_messages(cur, pending_batch):
        events.append(
            ("insert_messages", [record["message_id"] for record in pending_batch])
        )
        return {"<message@example.com>": 101}

    def fake_refresh_threads_for_message_ids(cur, list_id, message_ids):
        events.append(("refresh_threads", list_id, message_ids))

    def fake_auto_track_participation_for_inserted_messages(cur, inserted_message_ids):
        events.append(("auto_track_participation", inserted_message_ids))

    def fake_insert_attachments(cur, pending_batch, inserted_message_ids=None):
        events.append(
            (
                "insert_attachments",
                [record["message_id"] for record in pending_batch],
                inserted_message_ids,
            )
        )

    monkeypatch.setattr(
        ingest, "_resolve_batch_thread_ids", fake_resolve_batch_thread_ids
    )
    monkeypatch.setattr(ingest, "_insert_messages", fake_insert_messages)
    monkeypatch.setattr(
        ingest, "_refresh_threads_for_message_ids", fake_refresh_threads_for_message_ids
    )
    monkeypatch.setattr(
        ingest,
        "_auto_track_participation_for_inserted_messages",
        fake_auto_track_participation_for_inserted_messages,
    )
    monkeypatch.setattr(ingest, "_insert_attachments", fake_insert_attachments)

    ingest.store_batch_live(FakeConn(), batch)

    assert events == [
        ("resolve", ["<message@example.com>"]),
        ("insert_messages", ["<message@example.com>"]),
        ("refresh_threads", 23, ["<message@example.com>"]),
        ("auto_track_participation", {"<message@example.com>": 101}),
        (
            "insert_attachments",
            ["<message@example.com>"],
            {"<message@example.com>": 101},
        ),
        ("commit",),
    ]


def test_store_batch_backfill_does_not_auto_track_participation(ingest, monkeypatch):
    events = []

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()

        def cursor(self):
            return self._cursor

        def commit(self):
            events.append(("commit",))

    batch = [
        {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "",
            "from_email": "",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [],
            "_normalized_subject": "Subject",
        }
    ]

    def fake_resolve_batch_thread_ids(conn, pending_batch):
        events.append(("resolve", [record["message_id"] for record in pending_batch]))

    def fake_insert_messages(cur, pending_batch):
        events.append(("insert_messages", [record["message_id"] for record in pending_batch]))
        return {"<message@example.com>": 101}

    def fake_insert_attachments(cur, pending_batch, inserted_message_ids=None):
        events.append(("insert_attachments", inserted_message_ids))

    def fail_auto_track(*args, **kwargs):
        raise AssertionError("backfill should not auto-track participation")

    monkeypatch.setattr(
        ingest, "_resolve_batch_thread_ids", fake_resolve_batch_thread_ids
    )
    monkeypatch.setattr(ingest, "_insert_messages", fake_insert_messages)
    monkeypatch.setattr(ingest, "_insert_attachments", fake_insert_attachments)
    monkeypatch.setattr(
        ingest,
        "_auto_track_participation_for_inserted_messages",
        fail_auto_track,
    )

    ingest.store_batch_backfill(FakeConn(), batch)

    assert events == [
        ("resolve", ["<message@example.com>"]),
        ("insert_messages", ["<message@example.com>"]),
        ("insert_attachments", {"<message@example.com>": 101}),
        ("commit",),
    ]


def test_overwrite_messages_updates_existing_and_inserts_missing(ingest, monkeypatch):
    events = []

    class FakeCursor:
        pass

    batch = [
        {
            "message_id": "<existing@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "Existing",
            "from_email": "existing@example.com",
            "subject": "Existing subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Existing body",
            "_attachments": [],
            "_normalized_subject": "Existing subject",
        },
        {
            "message_id": "<new@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(2),
            "sent_at_approx": False,
            "from_name": "New",
            "from_email": "new@example.com",
            "subject": "New subject",
            "in_reply_to": None,
            "refs": None,
            "body": "New body",
            "_attachments": [],
            "_normalized_subject": "New subject",
        },
    ]

    def fake_fetch_existing_message_ids(cur, pending_batch):
        events.append(
            ("fetch_existing", [record["message_id"] for record in pending_batch])
        )
        return {"<existing@example.com>": 101}

    def fake_update_messages(cur, pending_batch):
        events.append(("update", [record["message_id"] for record in pending_batch]))
        return {"<existing@example.com>": 101}

    def fake_insert_messages(cur, pending_batch):
        events.append(("insert", [record["message_id"] for record in pending_batch]))
        return {"<new@example.com>": 202}

    monkeypatch.setattr(
        ingest, "_fetch_existing_message_ids", fake_fetch_existing_message_ids
    )
    monkeypatch.setattr(ingest, "_update_messages", fake_update_messages)
    monkeypatch.setattr(ingest, "_insert_messages", fake_insert_messages)

    id_map = ingest._overwrite_messages(FakeCursor(), batch)

    assert id_map == {
        "<existing@example.com>": 101,
        "<new@example.com>": 202,
    }
    assert events == [
        ("fetch_existing", ["<existing@example.com>", "<new@example.com>"]),
        ("update", ["<existing@example.com>"]),
        ("insert", ["<new@example.com>"]),
    ]


def test_store_batch_overwrite_rewrites_messages_and_attachments(ingest, monkeypatch):
    events = []

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()

        def cursor(self):
            return self._cursor

        def commit(self):
            events.append(("commit",))

    batch = [
        {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "Sender",
            "from_email": "sender@example.com",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [
                {
                    "filename": "one.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 12,
                    "content": "patch",
                }
            ],
            "_normalized_subject": "Subject",
        }
    ]

    def fake_resolve_batch_thread_ids(conn, pending_batch):
        events.append(("resolve", [record["message_id"] for record in pending_batch]))

    def fake_overwrite_messages(cur, pending_batch):
        events.append(
            ("overwrite_messages", [record["message_id"] for record in pending_batch])
        )
        return {"<message@example.com>": 101}

    def fake_replace_attachments_for_ids(
        cur, pending_batch, id_map, target_db_ids=None
    ):
        events.append(
            (
                "replace_attachments",
                [record["message_id"] for record in pending_batch],
                id_map,
                target_db_ids,
            )
        )
        return {
            "attachments_deleted": 1,
            "attachments_inserted": 1,
            "messages_repaired": 1,
        }

    monkeypatch.setattr(
        ingest, "_resolve_batch_thread_ids", fake_resolve_batch_thread_ids
    )
    monkeypatch.setattr(ingest, "_overwrite_messages", fake_overwrite_messages)
    monkeypatch.setattr(
        ingest, "_replace_attachments_for_ids", fake_replace_attachments_for_ids
    )

    ingest.store_batch_overwrite(FakeConn(), batch)

    assert events == [
        ("resolve", ["<message@example.com>"]),
        ("overwrite_messages", ["<message@example.com>"]),
        (
            "replace_attachments",
            ["<message@example.com>"],
            {"<message@example.com>": 101},
            None,
        ),
        ("commit",),
    ]


def test_store_batch_overwrite_does_not_auto_track_participation(ingest, monkeypatch):
    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()

        def cursor(self):
            return self._cursor

        def commit(self):
            return None

    batch = [
        {
            "message_id": "<message@example.com>",
            "thread_id": "<thread@example.com>",
            "list_id": 23,
            "archive_month": ts(1).date().replace(day=1),
            "sent_at": ts(1),
            "sent_at_approx": False,
            "from_name": "",
            "from_email": "",
            "subject": "Subject",
            "in_reply_to": None,
            "refs": None,
            "body": "Body",
            "_attachments": [],
            "_normalized_subject": "Subject",
        }
    ]

    monkeypatch.setattr(
        ingest,
        "_resolve_batch_thread_ids",
        lambda conn, pending_batch: None,
    )
    monkeypatch.setattr(ingest, "_overwrite_messages", lambda cur, pending_batch: {})
    monkeypatch.setattr(
        ingest,
        "_replace_attachments_for_ids",
        lambda cur, pending_batch, id_map, target_db_ids=None: {},
    )
    monkeypatch.setattr(
        ingest,
        "_auto_track_participation_for_inserted_messages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("overwrite should not auto-track participation")
        ),
    )

    ingest.store_batch_overwrite(FakeConn(), batch)


def test_insert_attachments_only_uses_newly_inserted_message_ids(ingest, monkeypatch):
    inserted = {}

    class FakeCursor:
        pass

    batch = [
        {
            "message_id": "<new@example.com>",
            "_attachments": [
                {
                    "filename": "new.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 12,
                    "content": "patch",
                }
            ],
        },
        {
            "message_id": "<existing@example.com>",
            "_attachments": [
                {
                    "filename": "existing.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 18,
                    "content": "existing",
                }
            ],
        },
    ]

    def fake_execute_batch(cur, sql, rows, page_size=500):
        inserted["sql"] = sql
        inserted["rows"] = rows
        inserted["page_size"] = page_size

    monkeypatch.setattr(ingest, "execute_batch", fake_execute_batch)

    ingest._insert_attachments(FakeCursor(), batch, {"<new@example.com>": 101})

    assert inserted == {
        "sql": ingest.INSERT_ATTACHMENT_SQL,
        "rows": [
            {
                "message_id": 101,
                "part_index": 0,
                "filename": "new.patch",
                "content_type": "text/x-diff",
                "size_bytes": 12,
                "content": "patch",
            }
        ],
        "page_size": 500,
    }


def test_replace_attachments_repairs_existing_messages(ingest, monkeypatch):
    recorded: dict[str, Any] = {"executions": []}

    class FakeCursor:
        def __init__(self):
            self.rowcount = 0

        def execute(self, sql, params):
            recorded["executions"].append((sql.strip(), params))
            if "FROM messages" in sql:
                self._rows = [
                    (101, "<new-attachments@example.com>"),
                    (102, "<existing-attachments@example.com>"),
                    (103, "<untouched@example.com>"),
                ]
            elif sql.strip() == ingest.DELETE_ATTACHMENTS_SQL.strip():
                self._rows = []
                self.rowcount = 5
            elif "FROM attachments" in sql:
                self._rows = [(102,)]
            else:
                self._rows = []

        def fetchall(self):
            return self._rows

    batch = [
        {
            "list_id": 1,
            "message_id": "<new-attachments@example.com>",
            "_attachments": [
                {
                    "filename": "new.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 12,
                    "content": "new",
                }
            ],
        },
        {
            "list_id": 1,
            "message_id": "<existing-attachments@example.com>",
            "_attachments": [
                {
                    "filename": "existing-1.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 18,
                    "content": "existing-1",
                },
                {
                    "filename": "existing-2.patch",
                    "content_type": "text/x-diff",
                    "size_bytes": 22,
                    "content": "existing-2",
                },
            ],
        },
        {
            "list_id": 1,
            "message_id": "<untouched@example.com>",
            "_attachments": [],
        },
    ]

    def fake_execute_batch(cur, sql, rows, page_size=500):
        recorded["insert_sql"] = sql
        recorded["rows"] = rows
        recorded["page_size"] = page_size

    monkeypatch.setattr(ingest, "execute_batch", fake_execute_batch)

    stats = ingest._replace_attachments(FakeCursor(), batch)

    assert stats == {
        "attachments_deleted": 5,
        "attachments_inserted": 3,
        "messages_repaired": 2,
    }
    assert recorded["insert_sql"] == ingest.INSERT_ATTACHMENT_SQL
    assert recorded["rows"] == [
        {
            "message_id": 101,
            "part_index": 0,
            "filename": "new.patch",
            "content_type": "text/x-diff",
            "size_bytes": 12,
            "content": "new",
        },
        {
            "message_id": 102,
            "part_index": 0,
            "filename": "existing-1.patch",
            "content_type": "text/x-diff",
            "size_bytes": 18,
            "content": "existing-1",
        },
        {
            "message_id": 102,
            "part_index": 1,
            "filename": "existing-2.patch",
            "content_type": "text/x-diff",
            "size_bytes": 22,
            "content": "existing-2",
        },
    ]
    assert recorded["page_size"] == 500


def test_prune_missing_messages_for_archive_month_rewrites_refs_before_delete(ingest):
    updated: list[tuple[str, list[tuple[int, int]], str, int]] = []
    executed: list[tuple[str, tuple[object, ...]]] = []

    class FakeCursor:
        def __init__(self):
            self._rows = []
            self.rowcount = 0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params):
            normalized = sql.strip()
            executed.append((normalized, params))
            self.rowcount = 0

            if normalized == ingest.store_lib.FETCH_ARCHIVE_MONTH_MESSAGE_IDS_SQL.strip():
                self._rows = [
                    (101, "<keep@example.com>"),
                    (202, "<stale@example.com>"),
                ]
            elif (
                normalized
                == ingest.store_lib.FETCH_STALE_REPLACEMENT_MESSAGE_IDS_SQL.strip()
            ):
                self._rows = [(202, 101)]
            elif normalized == ingest.store_lib.DELETE_STALE_THREAD_TRACKING_SQL.strip():
                self._rows = []
                self.rowcount = 1
            elif (
                normalized
                == ingest.store_lib.DELETE_STALE_THREAD_READ_PROGRESS_SQL.strip()
            ):
                self._rows = []
                self.rowcount = 2
            elif normalized == ingest.store_lib.DELETE_STALE_THREAD_FOLLOWS_SQL.strip():
                self._rows = []
                self.rowcount = 0
            elif normalized == ingest.store_lib.DELETE_ATTACHMENTS_SQL.strip():
                self._rows = []
                self.rowcount = 3
            elif normalized == ingest.store_lib.DELETE_MESSAGES_BY_DB_ID_SQL.strip():
                self._rows = []
                self.rowcount = 1
            else:
                raise AssertionError(f"unexpected SQL: {normalized}")

        def fetchall(self):
            return self._rows

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()
            self.commits = 0

        def cursor(self):
            return self._cursor

        def commit(self):
            self.commits += 1

    def fake_execute_values(cur, sql, rows, template, page_size=100):
        updated.append((sql.strip(), rows, template, page_size))

    conn = FakeConn()
    stats = ingest.store_lib.prune_missing_messages_for_archive_month(
        conn,
        list_id=23,
        archive_month=ts(1).date().replace(day=1),
        parsed_message_ids={"<keep@example.com>"},
        execute_values_fn=fake_execute_values,
    )

    assert stats == {
        "messages_pruned": 1,
        "attachments_deleted": 3,
        "tracking_rows_deleted": 1,
        "progress_rows_deleted": 2,
        "legacy_follow_rows_deleted": 0,
    }
    assert conn.commits == 1
    assert updated == [
        (
            ingest.store_lib.UPDATE_THREAD_TRACKING_ANCHORS_SQL.strip(),
            [(202, 101)],
            "(%s, %s)",
            500,
        ),
        (
            ingest.store_lib.UPDATE_THREAD_READ_PROGRESS_SQL.strip(),
            [(202, 101)],
            "(%s, %s)",
            500,
        ),
        (
            ingest.store_lib.UPDATE_THREAD_FOLLOWS_ANCHORS_SQL.strip(),
            [(202, 101)],
            "(%s, %s)",
            500,
        ),
    ]
    assert executed == [
        (
            ingest.store_lib.FETCH_ARCHIVE_MONTH_MESSAGE_IDS_SQL.strip(),
            (23, ts(1).date().replace(day=1)),
        ),
        (
            ingest.store_lib.FETCH_STALE_REPLACEMENT_MESSAGE_IDS_SQL.strip(),
            ([202], [202]),
        ),
        (ingest.store_lib.DELETE_STALE_THREAD_TRACKING_SQL.strip(), ([202],)),
        (ingest.store_lib.DELETE_STALE_THREAD_READ_PROGRESS_SQL.strip(), ([202],)),
        (ingest.store_lib.DELETE_STALE_THREAD_FOLLOWS_SQL.strip(), ([202],)),
        (ingest.store_lib.DELETE_ATTACHMENTS_SQL.strip(), ([202],)),
        (ingest.store_lib.DELETE_MESSAGES_BY_DB_ID_SQL.strip(), ([202],)),
    ]
