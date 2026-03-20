from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import secrets

from psycopg2.extras import execute_batch, execute_values

from src.ingestion.ingest_parse import _decode_subject


THREAD_STABLE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
THREAD_STABLE_ID_LENGTH = 10


REBUILD_TOUCHED_THREADS_SQL = """
    SELECT
        thread_id,
        list_id,
        _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST))[1]) AS subject,
        min(sent_at) AS started_at,
        max(sent_at) AS last_activity_at,
        count(*) AS message_count
    FROM messages
    WHERE list_id = %s
      AND thread_id = ANY(%s)
    GROUP BY thread_id, list_id
"""

INSERT_MESSAGE_COLUMNS = (
    "message_id",
    "thread_id",
    "list_id",
    "sent_at",
    "sent_at_approx",
    "from_name",
    "from_email",
    "subject",
    "in_reply_to",
    "refs",
    "body",
)

INSERT_MESSAGE_SQL = f"""
    INSERT INTO messages
        ({", ".join(INSERT_MESSAGE_COLUMNS)})
    VALUES %s
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id, message_id
"""

INSERT_MESSAGE_TEMPLATE = f"({', '.join(['%s'] * len(INSERT_MESSAGE_COLUMNS))})"

OVERWRITE_MESSAGE_SQL = f"""
    UPDATE messages AS m
    SET
        thread_id = v.thread_id,
        list_id = v.list_id,
        sent_at = v.sent_at,
        sent_at_approx = v.sent_at_approx,
        from_name = v.from_name,
        from_email = v.from_email,
        subject = v.subject,
        in_reply_to = v.in_reply_to,
        refs = v.refs,
        body = v.body
    FROM (VALUES %s) AS v ({", ".join(INSERT_MESSAGE_COLUMNS)})
    WHERE m.message_id = v.message_id
      AND m.list_id = v.list_id
    RETURNING m.id, m.message_id
"""

INSERT_ATTACHMENT_SQL = """
    INSERT INTO attachments (message_id, part_index, filename, content_type, size_bytes, content)
    VALUES (%(message_id)s, %(part_index)s, %(filename)s, %(content_type)s, %(size_bytes)s, %(content)s)
    ON CONFLICT (message_id, part_index) DO NOTHING
"""

DELETE_ATTACHMENTS_SQL = """
    DELETE FROM attachments
    WHERE message_id = ANY(%s)
"""

UPDATE_MESSAGE_THREAD_SQL = """
    UPDATE messages
    SET thread_id = %(thread_id)s
    WHERE message_id = %(message_id)s
"""

UPDATE_MESSAGE_SUBJECT_SQL = """
    UPDATE messages
    SET subject = %(subject)s
    WHERE message_id = %(message_id)s
"""

REBUILD_THREADS_SQL = """
    SELECT
        thread_id,
        list_id,
        _normalize_subject((array_agg(subject ORDER BY sent_at ASC NULLS LAST))[1]) AS subject,
        min(sent_at) AS started_at,
        max(sent_at) AS last_activity_at,
        count(*) AS message_count
    FROM messages
    GROUP BY thread_id, list_id
"""

UPSERT_TOUCHED_THREADS_SQL = """
    INSERT INTO threads (thread_id, id, list_id, subject, started_at, last_activity_at, message_count)
    SELECT
        v.thread_id,
        v.id,
        v.list_id,
        v.subject,
        v.started_at,
        v.last_activity_at,
        v.message_count
    FROM (VALUES %s) AS v (thread_id, id, list_id, subject, started_at, last_activity_at, message_count)
    ON CONFLICT (thread_id) DO UPDATE SET
        list_id          = EXCLUDED.list_id,
        subject          = EXCLUDED.subject,
        started_at       = EXCLUDED.started_at,
        last_activity_at = EXCLUDED.last_activity_at,
        message_count    = EXCLUDED.message_count
"""

UPSERT_REBUILT_THREADS_SQL = UPSERT_TOUCHED_THREADS_SQL

DELETE_STALE_THREADS_SQL = """
    DELETE FROM threads
    WHERE NOT EXISTS (
        SELECT 1
        FROM messages
        WHERE messages.thread_id = threads.thread_id
    )
"""

FETCH_THREAD_STABLE_IDS_SQL = """
    SELECT thread_id, id
    FROM threads
    WHERE thread_id = ANY(%s)
"""

FETCH_ALL_THREAD_STABLE_IDS_SQL = """
    SELECT id
    FROM threads
"""

PARTICIPATION_MATCHES_CTE = """
    WITH ranked_matches AS (
        SELECT
            users.id AS user_id,
            messages.thread_id,
            messages.id AS message_id,
            row_number() OVER (
                PARTITION BY users.id, messages.thread_id
                ORDER BY messages.sent_at DESC NULLS FIRST, messages.id DESC
            ) AS rank
        FROM messages
        INNER JOIN users
            ON lower(users.email) = lower(messages.from_email)
        WHERE messages.id = ANY(%s)
          AND users.status = 'active'
          AND users.email_verified_at IS NOT NULL
    ),
    matched_messages AS (
        SELECT user_id, thread_id, message_id
        FROM ranked_matches
        WHERE rank = 1
    )
"""

ACTIVE_TRACKING_SQL = """
    (
        thread_tracking.manual_followed_at IS NOT NULL
        OR thread_tracking.participation_suppressed_at IS NULL
    )
"""

UPSERT_PARTICIPATION_TRACKING_SQL = (
    PARTICIPATION_MATCHES_CTE
    + """
    INSERT INTO thread_tracking (
        user_id,
        thread_id,
        anchor_message_id,
        manual_followed_at,
        participated_at,
        participation_suppressed_at,
        created_at,
        updated_at
    )
    SELECT
        matched_messages.user_id,
        matched_messages.thread_id,
        matched_messages.message_id,
        NULL,
        now(),
        NULL,
        now(),
        now()
    FROM matched_messages
    ON CONFLICT (user_id, thread_id) DO UPDATE SET
        anchor_message_id = EXCLUDED.anchor_message_id,
        participated_at = COALESCE(
            thread_tracking.participated_at,
            EXCLUDED.participated_at
        ),
        updated_at = EXCLUDED.updated_at
"""
)

SEED_PARTICIPATION_PROGRESS_SQL = (
    PARTICIPATION_MATCHES_CTE
    + """
    INSERT INTO thread_read_progress (
        user_id,
        thread_id,
        last_read_message_id,
        updated_at
    )
    SELECT
        matched_messages.user_id,
        matched_messages.thread_id,
        matched_messages.message_id,
        now()
    FROM matched_messages
    INNER JOIN thread_tracking
        ON thread_tracking.user_id = matched_messages.user_id
       AND thread_tracking.thread_id = matched_messages.thread_id
    LEFT JOIN thread_read_progress
        ON thread_read_progress.user_id = matched_messages.user_id
       AND thread_read_progress.thread_id = matched_messages.thread_id
    WHERE """
    + ACTIVE_TRACKING_SQL
    + """
      AND thread_read_progress.user_id IS NULL
    ON CONFLICT (user_id, thread_id) DO NOTHING
"""
)

DELETE_INACTIVE_PARTICIPATION_PROGRESS_SQL = (
    PARTICIPATION_MATCHES_CTE
    + """
    DELETE FROM thread_read_progress
    USING thread_tracking, matched_messages
    WHERE thread_read_progress.user_id = thread_tracking.user_id
      AND thread_read_progress.thread_id = thread_tracking.thread_id
      AND matched_messages.user_id = thread_tracking.user_id
      AND matched_messages.thread_id = thread_tracking.thread_id
      AND thread_tracking.manual_followed_at IS NULL
      AND thread_tracking.participation_suppressed_at IS NOT NULL
"""
)

ADVANCE_PARTICIPATION_PROGRESS_SQL = (
    PARTICIPATION_MATCHES_CTE
    + """
    ,
    progress_candidates AS (
        SELECT
            matched_messages.user_id,
            matched_messages.thread_id,
            matched_messages.message_id AS candidate_message_id,
            thread_read_progress.last_read_message_id AS existing_message_id,
            candidate_messages.sent_at AS candidate_sent_at,
            existing_messages.sent_at AS existing_sent_at,
            existing_messages.thread_id AS existing_thread_id
        FROM matched_messages
        INNER JOIN thread_tracking
            ON thread_tracking.user_id = matched_messages.user_id
           AND thread_tracking.thread_id = matched_messages.thread_id
        INNER JOIN thread_read_progress
            ON thread_read_progress.user_id = matched_messages.user_id
           AND thread_read_progress.thread_id = matched_messages.thread_id
        INNER JOIN messages AS candidate_messages
            ON candidate_messages.id = matched_messages.message_id
        LEFT JOIN messages AS existing_messages
            ON existing_messages.id = thread_read_progress.last_read_message_id
        WHERE """
    + ACTIVE_TRACKING_SQL
    + """
    ),
    rows_to_advance AS (
        SELECT user_id, thread_id, candidate_message_id
        FROM progress_candidates
        WHERE existing_thread_id IS DISTINCT FROM thread_id
           OR (
               candidate_sent_at IS NULL
               AND existing_sent_at IS NOT NULL
           )
           OR (
               candidate_sent_at IS NULL
               AND existing_sent_at IS NULL
               AND candidate_message_id > existing_message_id
           )
           OR (
               candidate_sent_at IS NOT NULL
               AND existing_sent_at IS NOT NULL
               AND (
                   candidate_sent_at > existing_sent_at
                   OR (
                       candidate_sent_at = existing_sent_at
                       AND candidate_message_id > existing_message_id
                   )
               )
           )
    )
    UPDATE thread_read_progress
    SET
        last_read_message_id = rows_to_advance.candidate_message_id,
        updated_at = now()
    FROM rows_to_advance
    WHERE thread_read_progress.user_id = rows_to_advance.user_id
      AND thread_read_progress.thread_id = rows_to_advance.thread_id
"""
)


def _fetch_thread_ids(cur, list_id: int, message_ids: list[str]) -> dict[str, str]:
    if not message_ids:
        return {}
    cur.execute(
        "SELECT message_id, thread_id FROM messages WHERE list_id = %s AND message_id = ANY(%s)",
        (list_id, message_ids),
    )
    return {message_id: thread_id for message_id, thread_id in cur.fetchall()}


def _last_known_reference(
    message_id: str, refs: list[str] | None, known_message_ids: set[str]
) -> str | None:
    for ref in reversed(refs or []):
        if ref != message_id and ref in known_message_ids:
            return ref
    return None


def _effective_parent_id(
    message_id: str,
    record: dict,
    known_message_ids: set[str],
) -> str | None:
    parent_id = record.get("in_reply_to")
    if parent_id and parent_id != message_id and parent_id in known_message_ids:
        return parent_id
    return _last_known_reference(message_id, record.get("refs"), known_message_ids)


def _resolve_thread_ids(
    records: dict[str, dict],
    known_thread_ids: dict[str, str] | None = None,
) -> dict[str, str]:
    known_thread_ids = known_thread_ids or {}
    known_message_ids = set(records) | set(known_thread_ids)
    resolved: dict[str, str] = {}
    visiting: set[str] = set()

    def resolve(message_id: str) -> str:
        if message_id in resolved:
            return resolved[message_id]
        if message_id in visiting:
            return message_id

        record = records[message_id]
        visiting.add(message_id)
        refs = record.get("refs") or []
        parent_id = _effective_parent_id(message_id, record, known_message_ids)
        if parent_id:
            if parent_id in records:
                thread_id = resolve(parent_id)
            else:
                thread_id = known_thread_ids[parent_id]
        elif refs:
            thread_id = refs[0]
        else:
            thread_id = message_id
        visiting.remove(message_id)
        resolved[message_id] = thread_id
        return thread_id

    for message_id in records:
        resolve(message_id)

    return resolved


def _resolve_batch_thread_ids(
    conn,
    batch: list,
    *,
    fetch_thread_ids=_fetch_thread_ids,
):
    if not batch:
        return

    list_id = batch[0]["list_id"]
    batch_records = {
        record["message_id"]: {
            "in_reply_to": record.get("in_reply_to"),
            "refs": record.get("refs"),
        }
        for record in batch
    }
    known_ids_to_fetch = set()
    for record in batch:
        parent_id = record.get("in_reply_to")
        if parent_id and parent_id not in batch_records:
            known_ids_to_fetch.add(parent_id)
        for ref in record.get("refs") or []:
            if ref not in batch_records:
                known_ids_to_fetch.add(ref)

    with conn.cursor() as cur:
        known_thread_ids = fetch_thread_ids(cur, list_id, sorted(known_ids_to_fetch))

    resolved = _resolve_thread_ids(batch_records, known_thread_ids)
    for record in batch:
        record["thread_id"] = resolved[record["message_id"]]


def _message_sort_key(message_id: str, records: dict[str, dict]):
    sent_at = records[message_id].get("sent_at")
    return (
        sent_at is None,
        sent_at or datetime.max.replace(tzinfo=timezone.utc),
        message_id,
    )


def _canonical_thread_ids_for_list(records: dict[str, dict]) -> dict[str, str]:
    if not records:
        return {}

    known_message_ids = set(records)
    parents: dict[str, str] = {}

    class UnionFind:
        def __init__(self, items: list[str]):
            self.parent = {item: item for item in items}

        def find(self, item: str) -> str:
            while self.parent[item] != item:
                self.parent[item] = self.parent[self.parent[item]]
                item = self.parent[item]
            return item

        def union(self, left: str, right: str):
            left_root = self.find(left)
            right_root = self.find(right)
            if left_root != right_root:
                self.parent[right_root] = left_root

    uf = UnionFind(list(records))
    for message_id, record in records.items():
        parent_id = _effective_parent_id(message_id, record, known_message_ids)
        if not parent_id:
            continue
        parents[message_id] = parent_id
        uf.union(message_id, parent_id)

    components: dict[str, list[str]] = {}
    for message_id in records:
        root = uf.find(message_id)
        components.setdefault(root, []).append(message_id)

    canonical: dict[str, str] = {}
    for members in components.values():
        member_set = set(members)
        root_candidates = [
            message_id
            for message_id in members
            if parents.get(message_id) not in member_set
        ]
        candidates = root_candidates or members
        thread_id = min(
            candidates, key=lambda message_id: _message_sort_key(message_id, records)
        )
        for message_id in members:
            canonical[message_id] = thread_id

    return canonical


def _assign_stable_thread_ids(
    stable_id_counts_by_thread_id: dict[str, Counter[str]],
    preferred_stable_ids_by_thread_id: dict[str, str] | None = None,
) -> dict[str, str]:
    preferred_stable_ids_by_thread_id = preferred_stable_ids_by_thread_id or {}
    candidates: list[tuple[int, str, str]] = []
    for thread_id, stable_id_counts in stable_id_counts_by_thread_id.items():
        for stable_id, count in stable_id_counts.items():
            candidates.append((-count, stable_id, thread_id))

    candidates.sort()

    assigned_thread_ids: dict[str, str] = {}
    used_stable_ids: set[str] = set()
    for thread_id, stable_id in sorted(preferred_stable_ids_by_thread_id.items()):
        if stable_id_counts_by_thread_id[thread_id].get(stable_id, 0) <= 0:
            continue
        assigned_thread_ids[thread_id] = stable_id
        used_stable_ids.add(stable_id)

    for _, stable_id, thread_id in candidates:
        if thread_id in assigned_thread_ids or stable_id in used_stable_ids:
            continue
        assigned_thread_ids[thread_id] = stable_id
        used_stable_ids.add(stable_id)

    return assigned_thread_ids


def _generate_thread_stable_id(*, used_stable_ids: set[str]) -> str:
    while True:
        candidate = "".join(
            secrets.choice(THREAD_STABLE_ID_ALPHABET)
            for _ in range(THREAD_STABLE_ID_LENGTH)
        )
        if candidate in used_stable_ids:
            continue
        used_stable_ids.add(candidate)
        return candidate


def _fetch_thread_stable_ids(cur, thread_ids: list[str]) -> dict[str, str]:
    if not thread_ids:
        return {}

    cur.execute(FETCH_THREAD_STABLE_IDS_SQL, (thread_ids,))
    return {thread_id: stable_id for thread_id, stable_id in cur.fetchall()}


def _fetch_all_thread_stable_ids(cur) -> set[str]:
    cur.execute(FETCH_ALL_THREAD_STABLE_IDS_SQL)
    return {stable_id for (stable_id,) in cur.fetchall()}


def _resolve_stable_thread_ids(
    cur,
    thread_ids: list[str],
    assigned_stable_ids_by_thread_id: dict[str, str] | None = None,
    *,
    fetch_thread_stable_ids=_fetch_thread_stable_ids,
    fetch_all_thread_stable_ids=_fetch_all_thread_stable_ids,
    generate_thread_stable_id=_generate_thread_stable_id,
) -> dict[str, str]:
    stable_ids_by_thread_id = fetch_thread_stable_ids(cur, thread_ids)
    if assigned_stable_ids_by_thread_id:
        stable_ids_by_thread_id.update(assigned_stable_ids_by_thread_id)

    missing_thread_ids = [
        thread_id for thread_id in thread_ids if thread_id not in stable_ids_by_thread_id
    ]
    if not missing_thread_ids:
        return stable_ids_by_thread_id

    used_stable_ids = fetch_all_thread_stable_ids(cur)
    used_stable_ids.update(stable_ids_by_thread_id.values())
    for thread_id in missing_thread_ids:
        stable_ids_by_thread_id[thread_id] = generate_thread_stable_id(
            used_stable_ids=used_stable_ids
        )

    return stable_ids_by_thread_id


def _fetch_thread_aggregates(cur, list_id: int, thread_ids: list[str]):
    if not thread_ids:
        return []

    cur.execute(REBUILD_TOUCHED_THREADS_SQL, (list_id, thread_ids))
    return cur.fetchall()


def _upsert_thread_rows(
    cur,
    rows: list[tuple[str, str, int, str | None, datetime | None, datetime | None, int]],
    *,
    upsert_threads_sql=UPSERT_TOUCHED_THREADS_SQL,
    execute_values_fn=execute_values,
):
    if not rows:
        return

    execute_values_fn(
        cur,
        upsert_threads_sql,
        rows,
        template="(%s, %s, %s, %s, %s, %s, %s)",
        page_size=1000,
    )


def _insert_messages(cur, batch: list) -> dict[str, int]:
    """Insert a batch of messages and return DB ids for rows inserted in this batch."""
    if not batch:
        return {}

    rows = [
        tuple(record[column] for column in INSERT_MESSAGE_COLUMNS) for record in batch
    ]
    inserted_rows = execute_values(
        cur,
        INSERT_MESSAGE_SQL,
        rows,
        template=INSERT_MESSAGE_TEMPLATE,
        page_size=500,
        fetch=True,
    )
    return {message_id: db_id for db_id, message_id in inserted_rows}


def _update_messages(cur, batch: list) -> dict[str, int]:
    """Overwrite existing message rows in the current list and return their DB ids."""
    if not batch:
        return {}

    rows = [
        tuple(record[column] for column in INSERT_MESSAGE_COLUMNS) for record in batch
    ]
    updated_rows = execute_values(
        cur,
        OVERWRITE_MESSAGE_SQL,
        rows,
        template=INSERT_MESSAGE_TEMPLATE,
        page_size=500,
        fetch=True,
    )
    return {message_id: db_id for db_id, message_id in updated_rows}


def _fetch_existing_message_ids(cur, batch: list) -> dict[str, int]:
    if not batch:
        return {}

    msg_ids = [record["message_id"] for record in batch]
    list_id = batch[0]["list_id"]
    cur.execute(
        "SELECT id, message_id FROM messages WHERE list_id = %s AND message_id = ANY(%s)",
        (list_id, msg_ids),
    )
    return {message_id: db_id for db_id, message_id in cur.fetchall()}


def _attachment_rows_for_batch(
    batch: list,
    id_map: dict[str, int],
    allowed_db_ids: set[int] | None = None,
) -> list[dict]:
    att_rows = []
    for record in batch:
        db_id = id_map.get(record["message_id"])
        if db_id is None:
            continue
        if allowed_db_ids is not None and db_id not in allowed_db_ids:
            continue
        for part_index, att in enumerate(record.get("_attachments", [])):
            att_rows.append({**att, "message_id": db_id, "part_index": part_index})
    return att_rows


def _insert_attachments(
    cur,
    batch: list,
    inserted_message_ids: dict[str, int] | None = None,
    *,
    fetch_existing_message_ids=_fetch_existing_message_ids,
    attachment_rows_for_batch=_attachment_rows_for_batch,
    execute_batch_fn=execute_batch,
    insert_attachment_sql=INSERT_ATTACHMENT_SQL,
):
    """Insert attachments only for messages inserted in the current batch."""
    if inserted_message_ids is None:
        id_map = fetch_existing_message_ids(cur, batch)
    else:
        id_map = inserted_message_ids

    att_rows = attachment_rows_for_batch(batch, id_map)
    if att_rows:
        execute_batch_fn(cur, insert_attachment_sql, att_rows, page_size=500)


def _replace_attachments_for_ids(
    cur,
    batch: list,
    id_map: dict[str, int],
    target_db_ids: set[int] | None = None,
    *,
    attachment_rows_for_batch=_attachment_rows_for_batch,
    execute_batch_fn=execute_batch,
    delete_attachments_sql=DELETE_ATTACHMENTS_SQL,
    insert_attachment_sql=INSERT_ATTACHMENT_SQL,
) -> dict[str, int]:
    if not id_map:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    resolved_target_ids = (
        set(id_map.values()) if target_db_ids is None else set(target_db_ids)
    )
    if not resolved_target_ids:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    cur.execute(delete_attachments_sql, (sorted(resolved_target_ids),))
    deleted_rows = cur.rowcount

    att_rows = attachment_rows_for_batch(batch, id_map, resolved_target_ids)
    if att_rows:
        execute_batch_fn(cur, insert_attachment_sql, att_rows, page_size=500)

    return {
        "attachments_deleted": deleted_rows,
        "attachments_inserted": len(att_rows),
        "messages_repaired": len(resolved_target_ids),
    }


def _replace_attachments(
    cur,
    batch: list,
    *,
    fetch_existing_message_ids=_fetch_existing_message_ids,
    replace_attachments_for_ids=_replace_attachments_for_ids,
) -> dict[str, int]:
    """Replace attachments for existing messages represented in the current batch."""
    id_map = fetch_existing_message_ids(cur, batch)
    if not id_map:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    db_ids = sorted(set(id_map.values()))
    cur.execute(
        "SELECT DISTINCT message_id FROM attachments WHERE message_id = ANY(%s)",
        (db_ids,),
    )
    existing_attachment_ids = {message_id for (message_id,) in cur.fetchall()}

    target_db_ids = {
        db_id
        for record in batch
        if (db_id := id_map.get(record["message_id"])) is not None
        and (record.get("_attachments") or db_id in existing_attachment_ids)
    }
    return replace_attachments_for_ids(cur, batch, id_map, target_db_ids)


def _overwrite_messages(
    cur,
    batch: list,
    *,
    fetch_existing_message_ids=_fetch_existing_message_ids,
    update_messages=_update_messages,
    insert_messages=_insert_messages,
) -> dict[str, int]:
    """Insert new messages and overwrite existing rows in-place for the current list."""
    if not batch:
        return {}

    existing_message_ids = fetch_existing_message_ids(cur, batch)
    update_batch = [
        record for record in batch if record["message_id"] in existing_message_ids
    ]
    insert_batch = [
        record for record in batch if record["message_id"] not in existing_message_ids
    ]

    id_map = {}
    id_map.update(update_messages(cur, update_batch))
    id_map.update(insert_messages(cur, insert_batch))
    return id_map


def _refresh_threads_for_message_ids(
    cur,
    list_id: int,
    message_ids: list[str],
    *,
    fetch_thread_ids=_fetch_thread_ids,
    fetch_thread_aggregates=_fetch_thread_aggregates,
    resolve_stable_thread_ids=_resolve_stable_thread_ids,
    upsert_thread_rows=_upsert_thread_rows,
):
    thread_ids = sorted(set(fetch_thread_ids(cur, list_id, message_ids).values()))
    if not thread_ids:
        return

    rebuilt_threads = fetch_thread_aggregates(cur, list_id, thread_ids)
    if not rebuilt_threads:
        return

    stable_ids_by_thread_id = resolve_stable_thread_ids(
        cur,
        [thread_id for thread_id, *_ in rebuilt_threads],
    )
    rows = [
        (
            thread_id,
            stable_ids_by_thread_id[thread_id],
            rebuilt_list_id,
            subject,
            started_at,
            last_activity_at,
            message_count,
        )
        for thread_id, rebuilt_list_id, subject, started_at, last_activity_at, message_count in rebuilt_threads
    ]
    upsert_thread_rows(cur, rows)


def _auto_track_participation_for_inserted_messages(
    cur,
    inserted_message_ids: dict[str, int],
    *,
    upsert_participation_tracking_sql=UPSERT_PARTICIPATION_TRACKING_SQL,
    delete_inactive_participation_progress_sql=DELETE_INACTIVE_PARTICIPATION_PROGRESS_SQL,
    seed_participation_progress_sql=SEED_PARTICIPATION_PROGRESS_SQL,
    advance_participation_progress_sql=ADVANCE_PARTICIPATION_PROGRESS_SQL,
):
    if not inserted_message_ids:
        return

    inserted_db_ids = sorted(set(inserted_message_ids.values()))
    cur.execute(upsert_participation_tracking_sql, (inserted_db_ids,))
    cur.execute(delete_inactive_participation_progress_sql, (inserted_db_ids,))
    cur.execute(seed_participation_progress_sql, (inserted_db_ids,))
    cur.execute(advance_participation_progress_sql, (inserted_db_ids,))


def store_batch_live(
    conn,
    batch: list,
    *,
    resolve_batch_thread_ids=_resolve_batch_thread_ids,
    insert_messages=_insert_messages,
    refresh_threads_for_message_ids=_refresh_threads_for_message_ids,
    auto_track_participation_for_inserted_messages=_auto_track_participation_for_inserted_messages,
    insert_attachments=_insert_attachments,
):
    """Insert messages and refresh affected thread aggregates in one transaction."""
    if not batch:
        return

    resolve_batch_thread_ids(conn, batch)
    list_id = batch[0]["list_id"]
    message_ids = [record["message_id"] for record in batch]
    with conn.cursor() as cur:
        inserted_message_ids = insert_messages(cur, batch)
        refresh_threads_for_message_ids(cur, list_id, message_ids)
        auto_track_participation_for_inserted_messages(cur, inserted_message_ids)
        insert_attachments(cur, batch, inserted_message_ids)
    conn.commit()


def store_batch_backfill(
    conn,
    batch: list,
    *,
    resolve_batch_thread_ids=_resolve_batch_thread_ids,
    insert_messages=_insert_messages,
    insert_attachments=_insert_attachments,
):
    """Insert messages only; threads derived separately at the end."""
    resolve_batch_thread_ids(conn, batch)
    with conn.cursor() as cur:
        inserted_message_ids = insert_messages(cur, batch)
        insert_attachments(cur, batch, inserted_message_ids)
    conn.commit()


def store_batch_overwrite(
    conn,
    batch: list,
    *,
    resolve_batch_thread_ids=_resolve_batch_thread_ids,
    overwrite_messages=_overwrite_messages,
    replace_attachments_for_ids=_replace_attachments_for_ids,
):
    """Overwrite parsed message fields and attachments for the current batch."""
    if not batch:
        return

    resolve_batch_thread_ids(conn, batch)
    with conn.cursor() as cur:
        id_map = overwrite_messages(cur, batch)
        replace_attachments_for_ids(cur, batch, id_map)
    conn.commit()


def repair_batch_attachments(
    conn,
    batch: list,
    *,
    replace_attachments=_replace_attachments,
) -> dict[str, int]:
    """Replace attachments for existing messages in a parsed batch."""
    if not batch:
        return {
            "attachments_deleted": 0,
            "attachments_inserted": 0,
            "messages_repaired": 0,
        }

    with conn.cursor() as cur:
        stats = replace_attachments(cur, batch)
    conn.commit()
    return stats


def rethread_messages(conn):
    """Recompute messages.thread_id as canonical conversation IDs per list."""
    print("  [rethread messages]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                messages.list_id,
                messages.message_id,
                messages.sent_at,
                messages.in_reply_to,
                messages.refs,
                messages.thread_id,
                threads.id
            FROM messages
            LEFT JOIN threads
                ON threads.thread_id = messages.thread_id
            """
        )
        rows = cur.fetchall()

    records_by_list: dict[int, dict[str, dict]] = {}
    current_thread_ids: dict[tuple[int, str], str] = {}
    current_stable_ids: dict[tuple[int, str], str | None] = {}
    current_stable_ids_by_thread_id: dict[str, str] = {}
    for list_id, message_id, sent_at, in_reply_to, refs, thread_id, stable_id in rows:
        records_by_list.setdefault(list_id, {})[message_id] = {
            "sent_at": sent_at,
            "in_reply_to": in_reply_to,
            "refs": refs,
        }
        current_thread_ids[(list_id, message_id)] = thread_id
        current_stable_ids[(list_id, message_id)] = stable_id
        if stable_id is not None and thread_id not in current_stable_ids_by_thread_id:
            current_stable_ids_by_thread_id[thread_id] = stable_id

    updates = []
    stable_id_counts_by_thread_id: dict[str, Counter[str]] = defaultdict(Counter)
    for list_id, records in records_by_list.items():
        canonical_thread_ids = _canonical_thread_ids_for_list(records)
        for message_id, thread_id in canonical_thread_ids.items():
            stable_id = current_stable_ids[(list_id, message_id)]
            if stable_id is not None:
                stable_id_counts_by_thread_id[thread_id][stable_id] += 1
            if current_thread_ids[(list_id, message_id)] != thread_id:
                updates.append({"message_id": message_id, "thread_id": thread_id})

    with conn.cursor() as cur:
        if updates:
            execute_batch(cur, UPDATE_MESSAGE_THREAD_SQL, updates, page_size=1000)
    conn.commit()
    print(f" {len(updates)} messages updated")
    return _assign_stable_thread_ids(
        stable_id_counts_by_thread_id,
        current_stable_ids_by_thread_id,
    )


def decode_message_subjects(
    conn,
    *,
    decode_subject=_decode_subject,
    execute_batch_fn=execute_batch,
    update_message_subject_sql=UPDATE_MESSAGE_SUBJECT_SQL,
):
    """Decode stored RFC 2047 encoded-word subjects in messages."""
    print("  [decode subjects]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("SELECT message_id, subject FROM messages")
        rows = cur.fetchall()

    updates = []
    for message_id, subject in rows:
        decoded = decode_subject(subject)
        if decoded != subject:
            updates.append({"message_id": message_id, "subject": decoded})

    with conn.cursor() as cur:
        if updates:
            execute_batch_fn(cur, update_message_subject_sql, updates, page_size=1000)
    conn.commit()
    print(f" {len(updates)} messages updated")


def derive_threads(
    conn,
    *,
    rethread_messages_fn=rethread_messages,
    rebuild_threads_sql=REBUILD_THREADS_SQL,
    upsert_rebuilt_threads_sql=UPSERT_REBUILT_THREADS_SQL,
    delete_stale_threads_sql=DELETE_STALE_THREADS_SQL,
):
    """Rethread messages, then rebuild the derived threads table from messages."""
    assigned_stable_thread_ids = rethread_messages_fn(conn)
    print("  [derive threads]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute(rebuild_threads_sql)
        rebuilt_threads = cur.fetchall()
        stable_ids_by_thread_id = _resolve_stable_thread_ids(
            cur,
            [thread_id for thread_id, *_ in rebuilt_threads],
            assigned_stable_thread_ids,
        )
        cur.execute(delete_stale_threads_sql)

        if rebuilt_threads:
            rows = [
                (
                    thread_id,
                    stable_ids_by_thread_id[thread_id],
                    list_id,
                    subject,
                    started_at,
                    last_activity_at,
                    message_count,
                )
                for thread_id, list_id, subject, started_at, last_activity_at, message_count in rebuilt_threads
            ]
            execute_values(
                cur,
                upsert_rebuilt_threads_sql,
                rows,
                template="(%s, %s, %s, %s, %s, %s, %s)",
                page_size=1000,
            )
            count = len(rows)
        else:
            count = 0
    conn.commit()
    print(f" {count} threads rebuilt")


def refresh_analytics_views(conn):
    """Refresh analytics materialized views after archive data changes."""
    print("  [refresh analytics]", end="", flush=True)
    with conn.cursor() as cur:
        cur.execute("SELECT refresh_analytics_views()")
    conn.commit()
    print(" done")
