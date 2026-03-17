#!/usr/bin/env python3
"""
Quick smoke test: authenticate, download a month, and verify parsing works.

Usage:
    PG_LIST_USER=you PG_LIST_PASS=secret python3 parse_smoke.py
"""

import os
import sys

from ingest import download_mbox, make_session, parse_mbox

username = os.environ.get("PG_LIST_USER", "")
password = os.environ.get("PG_LIST_PASS", "")

if not username or not password:
    print("Set PG_LIST_USER and PG_LIST_PASS env vars")
    sys.exit(1)

YEAR, MONTH = 2026, 2
LIST = "pgsql-hackers"

print("[auth] logging in...")
session = make_session(username, password)

path = download_mbox(session, YEAR, MONTH, LIST)

msgs = list(parse_mbox(path, list_id=1))
print(f"\nParsed {len(msgs)} messages\n")

if msgs:
    sample = msgs[0]
    for k, v in sample.items():
        val = str(v)[:120].replace("\n", " ") if v else "(none)"
        print(f"  {k:<15} {val}")
