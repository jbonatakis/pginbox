from datetime import datetime, timezone


def ts(day: int) -> datetime:
    return datetime(2025, 1, day, tzinfo=timezone.utc)


def test_extract_message_id_prefers_last_for_in_reply_to(ingest):
    header = "<root@example.com> <parent@example.com>"

    assert ingest._extract_message_ids(header) == [
        "<root@example.com>",
        "<parent@example.com>",
    ]
    assert ingest._extract_message_id(header, prefer_last=True) == "<parent@example.com>"


def test_decode_subject_decodes_rfc2047_encoded_words(ingest):
    encoded = (
        "=?UTF-8?Q?=5BPATCH_v1=5D_command=5Ftag=5Fformat_=E2=80=94_protocol=2Dlevel_com?= "
        "=?UTF-8?Q?mand_tag_negotiation_via_=5Fpq=5F?="
    )

    assert ingest._decode_subject(encoded) == "[PATCH v1] command_tag_format — protocol-level command tag negotiation via _pq_"


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
            (17, ["<root@example.com>"]),
        )
    ]


def test_refresh_threads_for_message_ids_scopes_upsert_to_current_list(ingest, monkeypatch):
    calls = []

    class FakeCursor:
        def execute(self, sql, params):
            calls.append((sql, params))

    def fake_fetch_thread_ids(cur, list_id, message_ids):
        assert list_id == 42
        return {
            "<a@example.com>": "<shared-root@example.com>",
            "<b@example.com>": "<shared-root@example.com>",
        }

    monkeypatch.setattr(ingest, "_fetch_thread_ids", fake_fetch_thread_ids)

    ingest._refresh_threads_for_message_ids(
        FakeCursor(),
        42,
        ["<a@example.com>", "<b@example.com>"],
    )

    assert len(calls) == 1
    sql, params = calls[0]
    assert sql == ingest.UPSERT_TOUCHED_THREADS_SQL
    assert params[0] == 42
    assert params[1] == ["<shared-root@example.com>"]
