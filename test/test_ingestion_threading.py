from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location("ingest", ROOT / "src/ingestion/ingest.py")
ingest = module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ingest)


def ts(day: int) -> datetime:
    return datetime(2025, 1, day, tzinfo=timezone.utc)


def test_extract_message_id_prefers_last_for_in_reply_to():
    header = "<root@example.com> <parent@example.com>"

    assert ingest._extract_message_ids(header) == [
        "<root@example.com>",
        "<parent@example.com>",
    ]
    assert ingest._extract_message_id(header, prefer_last=True) == "<parent@example.com>"


def test_decode_subject_decodes_rfc2047_encoded_words():
    encoded = (
        "=?UTF-8?Q?=5BPATCH_v1=5D_command=5Ftag=5Fformat_=E2=80=94_protocol=2Dlevel_com?= "
        "=?UTF-8?Q?mand_tag_negotiation_via_=5Fpq=5F?="
    )

    assert ingest._decode_subject(encoded) == "[PATCH v1] command_tag_format — protocol-level command tag negotiation via _pq_"


def test_provisional_threading_prefers_known_parent_over_references_root():
    records = {
        "<child@example.com>": {
            "in_reply_to": "<parent@example.com>",
            "refs": ["<split@example.com>", "<parent@example.com>"],
        }
    }

    resolved = ingest._resolve_thread_ids(
        records,
        {"<parent@example.com>": "<root@example.com>"},
    )

    assert resolved["<child@example.com>"] == "<root@example.com>"


def test_provisional_threading_walks_same_batch_parent_chain():
    records = {
        "<root@example.com>": {
            "in_reply_to": None,
            "refs": None,
        },
        "<child@example.com>": {
            "in_reply_to": "<root@example.com>",
            "refs": None,
        },
        "<grandchild@example.com>": {
            "in_reply_to": "<child@example.com>",
            "refs": None,
        },
    }

    resolved = ingest._resolve_thread_ids(records)

    assert resolved == {
        "<root@example.com>": "<root@example.com>",
        "<child@example.com>": "<root@example.com>",
        "<grandchild@example.com>": "<root@example.com>",
    }


def test_provisional_threading_falls_back_to_references_when_parent_is_missing():
    records = {
        "<child@example.com>": {
            "in_reply_to": "<missing@example.com>",
            "refs": ["<root@example.com>", "<parent@example.com>"],
        }
    }

    resolved = ingest._resolve_thread_ids(records)

    assert resolved["<child@example.com>"] == "<root@example.com>"


def test_canonical_thread_ids_collapse_intermediate_references_root():
    records = {
        "<root@example.com>": {
            "sent_at": ts(1),
            "in_reply_to": None,
            "refs": None,
        },
        "<child@example.com>": {
            "sent_at": ts(2),
            "in_reply_to": "<root@example.com>",
            "refs": None,
        },
        "<split-root@example.com>": {
            "sent_at": ts(3),
            "in_reply_to": "<child@example.com>",
            "refs": None,
        },
        "<descendant@example.com>": {
            "sent_at": ts(4),
            "in_reply_to": "<split-root@example.com>",
            "refs": ["<split-root@example.com>"],
        },
    }

    canonical = ingest._canonical_thread_ids_for_list(records)

    assert canonical == {
        "<root@example.com>": "<root@example.com>",
        "<child@example.com>": "<root@example.com>",
        "<split-root@example.com>": "<root@example.com>",
        "<descendant@example.com>": "<root@example.com>",
    }


def test_canonical_thread_ids_change_when_delayed_parent_appears():
    provisional = ingest._resolve_thread_ids(
        {
            "<child@example.com>": {
                "in_reply_to": "<root@example.com>",
                "refs": None,
            }
        }
    )
    assert provisional["<child@example.com>"] == "<child@example.com>"

    canonical = ingest._canonical_thread_ids_for_list(
        {
            "<root@example.com>": {
                "sent_at": ts(1),
                "in_reply_to": None,
                "refs": None,
            },
            "<child@example.com>": {
                "sent_at": ts(2),
                "in_reply_to": "<root@example.com>",
                "refs": None,
            },
        }
    )

    assert canonical["<child@example.com>"] == "<root@example.com>"


def test_canonical_thread_ids_use_references_when_in_reply_to_is_missing():
    records = {
        "<root@example.com>": {
            "sent_at": ts(1),
            "in_reply_to": None,
            "refs": None,
        },
        "<reply@example.com>": {
            "sent_at": ts(2),
            "in_reply_to": None,
            "refs": ["<root@example.com>"],
        },
    }

    canonical = ingest._canonical_thread_ids_for_list(records)

    assert canonical["<reply@example.com>"] == "<root@example.com>"


def test_refresh_threads_for_message_ids_uses_persisted_thread_ids(monkeypatch):
    calls = []

    class FakeCursor:
        def execute(self, sql, params):
            calls.append((sql, params))

    fetched = {}

    def fake_fetch_thread_ids(cur, list_id, message_ids):
        fetched["list_id"] = list_id
        fetched["message_ids"] = message_ids
        return {
            "<one@example.com>": "<root@example.com>",
            "<two@example.com>": "<root@example.com>",
        }

    monkeypatch.setattr(ingest, "_fetch_thread_ids", fake_fetch_thread_ids)

    ingest._refresh_threads_for_message_ids(
        FakeCursor(),
        17,
        ["<one@example.com>", "<two@example.com>"],
    )

    assert fetched == {
        "list_id": 17,
        "message_ids": ["<one@example.com>", "<two@example.com>"],
    }
    assert calls == [
        (
            ingest.UPSERT_TOUCHED_THREADS_SQL,
            (["<root@example.com>"],),
        )
    ]


def test_parse_mbox_recovers_attachments_from_embedded_git_patch_from_lines(tmp_path):
    path = tmp_path / "pgsql-hackers.202409"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Sun Sep 01 01:33:15 2024
Date: Sun, 1 Sep 2024 02:27:50 -0400
From: Andres Freund <andres@anarazel.de>
To: pgsql-hackers@postgresql.org
Subject: AIO v2.0
Message-ID: <root@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary"
Content-Disposition: inline

--boundary
Content-Type: text/plain; charset=us-ascii
Content-Disposition: inline

Hi,

See attached patches.

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment;
 filename="0001-first.patch"

From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH 1/2] First patch

---
 file1 | 1 +
 1 file changed, 1 insertion(+)

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment;
 filename="0002-second.patch"

From abcdefabcdefabcdefabcdefabcdefabcdefabcd Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH 2/2] Second patch

---
 file2 | 1 +
 1 file changed, 1 insertion(+)

--boundary--
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 1
    assert records[0]["message_id"] == "<root@example.com>"
    assert [attachment["filename"] for attachment in records[0]["_attachments"]] == [
        "0001-first.patch",
        "0002-second.patch",
    ]


def test_store_batch_live_refreshes_threads_after_message_insert(monkeypatch):
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
        events.append(("insert_messages", [record["message_id"] for record in pending_batch]))
        return {"<message@example.com>": 101}

    def fake_refresh_threads_for_message_ids(cur, list_id, message_ids):
        events.append(("refresh_threads", list_id, message_ids))

    def fake_insert_attachments(cur, pending_batch, inserted_message_ids=None):
        events.append((
            "insert_attachments",
            [record["message_id"] for record in pending_batch],
            inserted_message_ids,
        ))

    monkeypatch.setattr(ingest, "_resolve_batch_thread_ids", fake_resolve_batch_thread_ids)
    monkeypatch.setattr(ingest, "_insert_messages", fake_insert_messages)
    monkeypatch.setattr(ingest, "_refresh_threads_for_message_ids", fake_refresh_threads_for_message_ids)
    monkeypatch.setattr(ingest, "_insert_attachments", fake_insert_attachments)

    ingest.store_batch_live(FakeConn(), batch)

    assert events == [
        ("resolve", ["<message@example.com>"]),
        ("insert_messages", ["<message@example.com>"]),
        ("refresh_threads", 23, ["<message@example.com>"]),
        ("insert_attachments", ["<message@example.com>"], {"<message@example.com>": 101}),
        ("commit",),
    ]


def test_insert_attachments_only_uses_newly_inserted_message_ids(monkeypatch):
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
