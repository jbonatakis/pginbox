from datetime import datetime, timezone


def ts(day: int) -> datetime:
    return datetime(2025, 1, day, tzinfo=timezone.utc)


def test_extract_message_id_prefers_last_for_in_reply_to(ingest):
    header = "<root@example.com> <parent@example.com>"

    assert ingest._extract_message_ids(header) == [
        "<root@example.com>",
        "<parent@example.com>",
    ]
    assert (
        ingest._extract_message_id(header, prefer_last=True) == "<parent@example.com>"
    )


def test_decode_subject_decodes_rfc2047_encoded_words(ingest):
    encoded = (
        "=?UTF-8?Q?=5BPATCH_v1=5D_command=5Ftag=5Fformat_=E2=80=94_protocol=2Dlevel_com?= "
        "=?UTF-8?Q?mand_tag_negotiation_via_=5Fpq=5F?="
    )

    assert (
        ingest._decode_subject(encoded)
        == "[PATCH v1] command_tag_format — protocol-level command tag negotiation via _pq_"
    )


def test_provisional_threading_prefers_known_parent_over_references_root(ingest):
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


def test_provisional_threading_walks_same_batch_parent_chain(ingest):
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


def test_provisional_threading_falls_back_to_references_when_parent_is_missing(ingest):
    records = {
        "<child@example.com>": {
            "in_reply_to": "<missing@example.com>",
            "refs": ["<root@example.com>", "<parent@example.com>"],
        }
    }

    resolved = ingest._resolve_thread_ids(records)

    assert resolved["<child@example.com>"] == "<root@example.com>"


def test_canonical_thread_ids_collapse_intermediate_references_root(ingest):
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


def test_canonical_thread_ids_change_when_delayed_parent_appears(ingest):
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


def test_canonical_thread_ids_use_references_when_in_reply_to_is_missing(ingest):
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


def test_refresh_threads_for_message_ids_uses_persisted_thread_ids(ingest, monkeypatch):
    fetched = {}
    rebuilt = {}
    resolved = {}
    upserts = []

    class FakeCursor:
        pass

    def fake_fetch_thread_ids(cur, list_id, message_ids):
        fetched["list_id"] = list_id
        fetched["message_ids"] = message_ids
        return {
            "<one@example.com>": "<root@example.com>",
            "<two@example.com>": "<root@example.com>",
        }

    def fake_fetch_thread_aggregates(cur, list_id, thread_ids):
        rebuilt["list_id"] = list_id
        rebuilt["thread_ids"] = thread_ids
        return [
            ("<root@example.com>", 17, "Subject", None, None, 2),
        ]

    def fake_resolve_stable_thread_ids(cur, thread_ids, assigned_stable_ids_by_thread_id=None):
        resolved["thread_ids"] = thread_ids
        resolved["assigned"] = assigned_stable_ids_by_thread_id
        return {"<root@example.com>": "THREAD0001"}

    def fake_upsert_thread_rows(cur, rows):
        upserts.append(rows)

    monkeypatch.setattr(ingest, "_fetch_thread_ids", fake_fetch_thread_ids)

    ingest._refresh_threads_for_message_ids(
        FakeCursor(),
        17,
        ["<one@example.com>", "<two@example.com>"],
        fetch_thread_aggregates=fake_fetch_thread_aggregates,
        resolve_stable_thread_ids=fake_resolve_stable_thread_ids,
        upsert_thread_rows=fake_upsert_thread_rows,
    )

    assert fetched == {
        "list_id": 17,
        "message_ids": ["<one@example.com>", "<two@example.com>"],
    }
    assert rebuilt == {
        "list_id": 17,
        "thread_ids": ["<root@example.com>"],
    }
    assert resolved == {
        "thread_ids": ["<root@example.com>"],
        "assigned": None,
    }
    assert upserts == [
        [
            ("<root@example.com>", "THREAD0001", 17, "Subject", None, None, 2),
        ]
    ]


def test_refresh_threads_for_message_ids_scopes_upsert_to_current_list(
    ingest, monkeypatch
):
    rebuilt = {}

    def fake_fetch_thread_ids(cur, list_id, message_ids):
        assert list_id == 42
        return {
            "<a@example.com>": "<shared-root@example.com>",
            "<b@example.com>": "<shared-root@example.com>",
        }

    def fake_fetch_thread_aggregates(cur, list_id, thread_ids):
        rebuilt["list_id"] = list_id
        rebuilt["thread_ids"] = thread_ids
        return []

    monkeypatch.setattr(ingest, "_fetch_thread_ids", fake_fetch_thread_ids)

    ingest._refresh_threads_for_message_ids(
        object(),
        42,
        ["<a@example.com>", "<b@example.com>"],
        fetch_thread_aggregates=fake_fetch_thread_aggregates,
    )

    assert rebuilt == {
        "list_id": 42,
        "thread_ids": ["<shared-root@example.com>"],
    }


def test_resolve_stable_thread_ids_rekeys_conflicting_batch_owner(ingest):
    generated_for = []

    def fake_fetch_thread_stable_ids(cur, thread_ids):
        assert thread_ids == ["thread-a", "thread-b"]
        return {
            "thread-a": "STABLEA001",
            "thread-b": "STABLEB001",
        }

    def fake_fetch_thread_ids_by_stable_ids(cur, stable_ids):
        assert stable_ids == ["STABLEB001"]
        return {
            "STABLEB001": "thread-b",
        }

    def fake_fetch_all_thread_stable_ids(cur):
        return {"STABLEA001", "STABLEB001"}

    def fake_generate_thread_stable_id(*, used_stable_ids):
        generated_for.append(set(used_stable_ids))
        used_stable_ids.add("STABLEC001")
        return "STABLEC001"

    resolved = ingest.store_lib._resolve_stable_thread_ids(
        object(),
        ["thread-a", "thread-b"],
        {"thread-a": "STABLEB001"},
        fetch_thread_stable_ids=fake_fetch_thread_stable_ids,
        fetch_all_thread_stable_ids=fake_fetch_all_thread_stable_ids,
        fetch_thread_ids_by_stable_ids=fake_fetch_thread_ids_by_stable_ids,
        generate_thread_stable_id=fake_generate_thread_stable_id,
    )

    assert resolved == {
        "thread-a": "STABLEB001",
        "thread-b": "STABLEC001",
    }
    assert generated_for == [{"STABLEA001", "STABLEB001"}]


def test_resolve_stable_thread_ids_does_not_steal_from_untouched_thread(ingest):
    generated_for = []

    def fake_fetch_thread_stable_ids(cur, thread_ids):
        assert thread_ids == ["thread-a", "thread-c"]
        return {
            "thread-a": "STABLEA001",
        }

    def fake_fetch_thread_ids_by_stable_ids(cur, stable_ids):
        assert stable_ids == ["STABLEB001"]
        return {
            "STABLEB001": "thread-b",
        }

    def fake_fetch_all_thread_stable_ids(cur):
        return {"STABLEA001", "STABLEB001"}

    def fake_generate_thread_stable_id(*, used_stable_ids):
        generated_for.append(set(used_stable_ids))
        used_stable_ids.add("STABLEC001")
        return "STABLEC001"

    resolved = ingest.store_lib._resolve_stable_thread_ids(
        object(),
        ["thread-a", "thread-c"],
        {"thread-c": "STABLEB001"},
        fetch_thread_stable_ids=fake_fetch_thread_stable_ids,
        fetch_all_thread_stable_ids=fake_fetch_all_thread_stable_ids,
        fetch_thread_ids_by_stable_ids=fake_fetch_thread_ids_by_stable_ids,
        generate_thread_stable_id=fake_generate_thread_stable_id,
    )

    assert resolved == {
        "thread-a": "STABLEA001",
        "thread-c": "STABLEC001",
    }
    assert generated_for == [{"STABLEA001", "STABLEB001"}]


def test_derive_threads_deletes_stale_threads_before_resolving_stable_ids(
    ingest, monkeypatch
):
    events = []

    class FakeCursor:
        def __init__(self):
            self.executed = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params=None):
            self.executed.append((sql, params))

        def fetchall(self):
            return []

    class FakeConn:
        def __init__(self):
            self._cursor = FakeCursor()

        def cursor(self):
            return self._cursor

        def commit(self):
            events.append(("commit",))

    def fake_rethread_messages(conn, list_ids=None):
        events.append(("rethread", list_ids))
        return {}

    def fake_resolve_stable_thread_ids(cur, thread_ids, assigned_stable_ids_by_thread_id=None):
        events.append(("resolve", thread_ids, assigned_stable_ids_by_thread_id))
        assert ("DELETE", ([23],)) in cur.executed
        return {}

    monkeypatch.setattr(ingest.store_lib, "_resolve_stable_thread_ids", fake_resolve_stable_thread_ids)

    ingest.store_lib.derive_threads(
        FakeConn(),
        list_ids=[23],
        rethread_messages_fn=fake_rethread_messages,
        rebuild_threads_for_lists_sql="REBUILD",
        delete_stale_threads_for_lists_sql="DELETE",
    )

    assert events == [
        ("rethread", [23]),
        ("resolve", [], {}),
        ("commit",),
    ]
