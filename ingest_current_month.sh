#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

UV_BIN="${UV_BIN:-$(command -v uv || true)}"
if [[ -z "$UV_BIN" ]]; then
  echo "uv not found on PATH" >&2
  exit 1
fi

DSN="${ENCODED_DATABASE_URL:-${DATABASE_URL:-${SUPABASE_URL:-}}}"
if [[ -z "$DSN" ]]; then
  echo "Set ENCODED_DATABASE_URL, DATABASE_URL, or SUPABASE_URL in the environment or .env" >&2
  exit 1
fi

LIST_NAME="${1:-${PGINBOX_LIST_NAME:-pgsql-hackers}}"
YEAR="$(date -u +%Y)"
MONTH="$(date -u +%-m)"

exec "$UV_BIN" run python3 src/ingestion/ingest.py \
  --list "$LIST_NAME" \
  --year "$YEAR" \
  --month "$MONTH" \
  --force-download \
  --dsn "$DSN"
