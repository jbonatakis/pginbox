from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location("ingest", ROOT / "src/ingestion/ingest.py")
ingest = module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ingest)


def test_extract_message_id_prefers_last_for_in_reply_to():
    header = "<root@example.com> <parent@example.com>"

    assert ingest._extract_message_ids(header) == [
        "<root@example.com>",
        "<parent@example.com>",
    ]
    assert ingest._extract_message_id(header, prefer_last=True) == "<parent@example.com>"


def test_resolve_thread_ids_uses_known_parent_thread_id_when_references_missing():
    records = {
        "<child@example.com>": {
            "in_reply_to": "<parent@example.com>",
            "refs": None,
        }
    }

    resolved = ingest._resolve_thread_ids(
        records,
        {"<parent@example.com>": "<root@example.com>"},
    )

    assert resolved["<child@example.com>"] == "<root@example.com>"


def test_resolve_thread_ids_walks_same_batch_parent_chain():
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


def test_resolve_thread_ids_prefers_references_root_over_parent_chain():
    records = {
        "<parent@example.com>": {
            "in_reply_to": None,
            "refs": None,
        },
        "<child@example.com>": {
            "in_reply_to": "<parent@example.com>",
            "refs": ["<explicit-root@example.com>", "<parent@example.com>"],
        },
    }

    resolved = ingest._resolve_thread_ids(records)

    assert resolved["<child@example.com>"] == "<explicit-root@example.com>"


def test_resolve_thread_ids_self_roots_when_parent_is_missing():
    records = {
        "<child@example.com>": {
            "in_reply_to": "<missing@example.com>",
            "refs": None,
        }
    }

    resolved = ingest._resolve_thread_ids(records)

    assert resolved["<child@example.com>"] == "<child@example.com>"
