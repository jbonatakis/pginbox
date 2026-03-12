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
