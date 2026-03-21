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

usage() {
  cat <<'EOF'
Usage: ./ingest_current_month.sh [list-name ...] [ingest.py options]

Runs the current month ingest for one or more tracked lists.

Examples:
  ./ingest_current_month.sh
  ./ingest_current_month.sh pgsql-hackers
  ./ingest_current_month.sh --skip-analytics
  ./ingest_current_month.sh pgsql-hackers pgsql-general --skip-analytics

Common passthrough options:
  --skip-analytics    Skip refreshing analytics materialized views after ingest
  --backfill          Bulk-insert messages and defer thread rebuild
  --overwrite-existing
                      Reparse archives and overwrite stored rows in place

Any option beginning with '-' is passed through to src/ingestion/ingest.py.
Any positional argument is treated as a list name.
EOF
}

load_default_list_names() {
  if [[ -n "${PGINBOX_LIST_NAMES:-}" ]]; then
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
  while (( $# > 0 )); do
    arg="$1"
    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
      usage
      exit 0
    fi
    case "$arg" in
      --delay|--parallel|--dsn|--pg-user|--pg-pass|--lists-file|--year|--month|--from|--to)
        INGEST_EXTRA_ARGS+=("$arg")
        shift
        if (( $# == 0 )); then
          log "missing value for $arg" >&2
          exit 1
        fi
        INGEST_EXTRA_ARGS+=("$1")
        ;;
      -*)
        INGEST_EXTRA_ARGS+=("$arg")
        ;;
      *)
        LIST_NAMES+=("$arg")
        ;;
    esac
    shift
  done
else
  load_default_list_names
fi

if (( ${#LIST_NAMES[@]} == 0 )); then
  load_default_list_names
fi

YEAR="$(date +%Y)"
MONTH="$(date +%-m)"
DAY="$(date +%-d)"

INGEST_ARGS=()
for LIST_NAME in "${LIST_NAMES[@]}"; do
  INGEST_ARGS+=(--list "$LIST_NAME")
done

# On the first day of a new month, also ingest the previous month to catch
# messages that arrived after the last hourly run (between ~23:17 and 23:59:59
# on the final day). The previous month's mbox is now frozen so this adds one
# extra download per hour on the 1st only.
if [[ "$DAY" -eq 1 ]]; then
  if [[ "$MONTH" -eq 1 ]]; then
    PREV_YEAR=$(( YEAR - 1 ))
    PREV_MONTH=12
  else
    PREV_YEAR="$YEAR"
    PREV_MONTH=$(( MONTH - 1 ))
  fi
  DATE_ARGS=(--from "${PREV_YEAR}-${PREV_MONTH}" --to "${YEAR}-${MONTH}")
  log "run started: ingesting ${#LIST_NAMES[@]} list(s) for ${PREV_YEAR}-${PREV_MONTH} through ${YEAR}-${MONTH} (day-1 catch-up) using a shared auth session"
else
  DATE_ARGS=(--year "$YEAR" --month "$MONTH")
  log "run started: ingesting ${#LIST_NAMES[@]} list(s) for $YEAR-$MONTH using a shared auth session"
fi

INGEST_CMD=(
  "$UV_BIN"
  run
  python3
  src/ingestion/ingest.py
  "${INGEST_ARGS[@]}"
  "${DATE_ARGS[@]}"
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
