#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.ingestion.ingest_parse import parse_message_bytes


def _json_default(value):
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _parse_archive_month(raw_value: str) -> date:
    try:
        year_str, month_str = raw_value.split("-", 1)
        return date(int(year_str), int(month_str), 1)
    except Exception as exc:
        raise argparse.ArgumentTypeError(
            "--archive-month must be in YYYY-MM format"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Parse one raw RFC822 message from stdin and emit normalized JSON."
    )
    parser.add_argument("--list-id", required=True, type=int)
    parser.add_argument("--archive-month", type=_parse_archive_month)
    args = parser.parse_args(argv)

    raw_bytes = sys.stdin.buffer.read()
    if not raw_bytes:
        raise SystemExit("stdin must contain one raw RFC822 message")

    record = parse_message_bytes(
        raw_bytes,
        list_id=args.list_id,
        archive_month_hint=args.archive_month,
    )
    json.dump(record, sys.stdout, default=_json_default)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
