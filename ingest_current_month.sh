#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

UV_BIN="${UV_BIN:-$(command -v uv || true)}"
if [[ -z "$UV_BIN" ]]; then
  log "uv not found on PATH" >&2
  exit 1
fi

DSN="${ENCODED_DATABASE_URL:-${DATABASE_URL:-${SUPABASE_URL:-}}}"
if [[ -z "$DSN" ]]; then
  log "Set ENCODED_DATABASE_URL, DATABASE_URL, or SUPABASE_URL in the environment or .env" >&2
  exit 1
fi

LIST_NAMES=()
INGEST_EXTRA_ARGS=()
TRACKED_LISTS_FILE="${TRACKED_LISTS_FILE:-$ROOT_DIR/lists.tracked}"
if (( $# > 0 )); then
  for arg in "$@"; do
    if [[ "$arg" == -* ]]; then
      INGEST_EXTRA_ARGS+=("$arg")
    else
      LIST_NAMES+=("$arg")
    fi
  done
elif [[ -n "${PGINBOX_LIST_NAMES:-}" ]]; then
  LIST_NAMES=($(printf '%s' "$PGINBOX_LIST_NAMES" | tr ',' ' '))
elif [[ -f "$TRACKED_LISTS_FILE" ]]; then
  while IFS= read -r line; do
    list_name="${line%%#*}"
    list_name="${list_name#"${list_name%%[![:space:]]*}"}"
    list_name="${list_name%"${list_name##*[![:space:]]}"}"
    if [[ -n "$list_name" ]]; then
      LIST_NAMES+=("$list_name")
    fi
  done < "$TRACKED_LISTS_FILE"
elif [[ -n "${PGINBOX_LIST_NAME:-}" ]]; then
  LIST_NAMES=("$PGINBOX_LIST_NAME")
else
  LIST_NAMES=("pgsql-hackers")
fi

if (( ${#LIST_NAMES[@]} == 0 )); then
  LIST_NAMES=("pgsql-hackers")
fi

YEAR="$(date +%Y)"
MONTH="$(date +%-m)"

INGEST_ARGS=()
for LIST_NAME in "${LIST_NAMES[@]}"; do
  INGEST_ARGS+=(--list "$LIST_NAME")
done

log "run started: ingesting ${#LIST_NAMES[@]} list(s) for $YEAR-$MONTH using a shared auth session"
INGEST_CMD=(
  "$UV_BIN"
  run
  python3
  src/ingestion/ingest.py
  "${INGEST_ARGS[@]}"
  --year "$YEAR"
  --month "$MONTH"
  --force-download
  --dsn "$DSN"
)
if (( ${#INGEST_EXTRA_ARGS[@]} > 0 )); then
  INGEST_CMD+=("${INGEST_EXTRA_ARGS[@]}")
fi

"${INGEST_CMD[@]}" 2>&1 | while IFS= read -r line; do
  log "$line"
done

status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]]; then
  log "run finished successfully"
else
  log "run failed with exit code $status" >&2
fi
exit "$status"
