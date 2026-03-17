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
    monkeypatch.setattr(ingest, "_insert_attachments", fake_insert_attachments)

    ingest.store_batch_live(FakeConn(), batch)

    assert events == [
        ("resolve", ["<message@example.com>"]),
        ("insert_messages", ["<message@example.com>"]),
        ("refresh_threads", 23, ["<message@example.com>"]),
        (
            "insert_attachments",
            ["<message@example.com>"],
            {"<message@example.com>": 101},
        ),
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
