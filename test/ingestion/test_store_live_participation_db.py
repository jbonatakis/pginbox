import os
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import psycopg2
import pytest


def ts(day: int) -> datetime:
    return datetime(2025, 3, day, tzinfo=timezone.utc)


def _test_database_url() -> str:
    dsn = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not dsn:
        pytest.skip("TEST_DATABASE_URL is not configured for ingestion DB tests")

    database_name = urlparse(dsn).path.lstrip("/")
    if not database_name.endswith("_test"):
        raise RuntimeError(
            "TEST_DATABASE_URL must point to a dedicated test database ending in '_test'"
        )

    return dsn


def _cleanup_test_rows(conn, token: str):
    pattern = f"%{token}%"
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE message_id LIKE %s)",
            (pattern,),
        )
        cur.execute(
            "DELETE FROM thread_read_progress WHERE thread_id LIKE %s OR user_id IN (SELECT id FROM users WHERE email LIKE %s)",
            (pattern, pattern),
        )
        cur.execute(
            "DELETE FROM thread_tracking WHERE thread_id LIKE %s OR user_id IN (SELECT id FROM users WHERE email LIKE %s)",
            (pattern, pattern),
        )
        cur.execute("DELETE FROM messages WHERE message_id LIKE %s", (pattern,))
        cur.execute("DELETE FROM threads WHERE thread_id LIKE %s", (pattern,))
        cur.execute("DELETE FROM lists WHERE name LIKE %s", (pattern,))
        cur.execute("DELETE FROM users WHERE email LIKE %s", (pattern,))
    conn.commit()


@pytest.fixture
def live_ingest_db():
    try:
        conn = psycopg2.connect(_test_database_url())
    except psycopg2.OperationalError as exc:
        pytest.skip(f"ingestion DB tests require a reachable TEST_DATABASE_URL: {exc}")
    token = f"ingest-live-{uuid4().hex}"
    _cleanup_test_rows(conn, token)
    try:
        yield conn, token
    finally:
        conn.rollback()
        _cleanup_test_rows(conn, token)
        conn.close()


def insert_list(conn, token: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO lists (name) VALUES (%s) RETURNING id",
            (f"{token}-list",),
        )
        list_id = cur.fetchone()[0]
    conn.commit()
    return list_id


def insert_user(
    conn,
    *,
    email: str,
    status: str,
    email_verified_at: datetime | None,
    disabled_at: datetime | None = None,
):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO users (
                email,
                display_name,
                password_hash,
                status,
                email_verified_at,
                disabled_at,
                disable_reason
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                email,
                "Test User",
                "not-a-real-hash",
                status,
                email_verified_at,
                disabled_at,
                "test disable" if disabled_at else None,
            ),
        )
        user_id = cur.fetchone()[0]
    conn.commit()
    return user_id


def make_record(
    token: str,
    list_id: int,
    suffix: str,
    *,
    sent_at: datetime,
    from_email: str,
    subject: str = "Subject",
    in_reply_to: str | None = None,
    refs: list[str] | None = None,
):
    message_id = f"<{token}-{suffix}@example.com>"
    return {
        "message_id": message_id,
        "thread_id": refs[0] if refs else message_id,
        "list_id": list_id,
        "sent_at": sent_at,
        "sent_at_approx": False,
        "from_name": "Sender",
        "from_email": from_email,
        "subject": subject,
        "in_reply_to": in_reply_to,
        "refs": refs,
        "body": f"Body for {suffix}",
        "_attachments": [],
        "_normalized_subject": subject,
    }


def fetch_message(conn, message_id: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, thread_id FROM messages WHERE message_id = %s",
            (message_id,),
        )
        row = cur.fetchone()
    assert row is not None
    return row


def fetch_tracking_row(conn, user_id: int, thread_id: str):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                anchor_message_id,
                manual_followed_at,
                participated_at,
                participation_suppressed_at
            FROM thread_tracking
            WHERE user_id = %s AND thread_id = %s
            """,
            (user_id, thread_id),
        )
        return cur.fetchone()


def fetch_progress_row(conn, user_id: int, thread_id: str):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT last_read_message_id
            FROM thread_read_progress
            WHERE user_id = %s AND thread_id = %s
            """,
            (user_id, thread_id),
        )
        return cur.fetchone()


def test_live_ingest_tracks_matching_verified_active_user_and_seeds_progress(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    user_email = f"{token}-active@example.com"
    user_id = insert_user(
        conn,
        email=user_email,
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    batch = [
        make_record(
            token,
            list_id,
            "root",
            sent_at=ts(2),
            from_email=user_email.upper(),
        )
    ]

    ingest.store_batch_live(conn, batch)

    message_db_id, thread_id = fetch_message(conn, batch[0]["message_id"])
    tracking = fetch_tracking_row(conn, user_id, thread_id)
    progress = fetch_progress_row(conn, user_id, thread_id)

    assert tracking is not None
    assert tracking[0] == message_db_id
    assert tracking[1] is None
    assert tracking[2] is not None
    assert tracking[3] is None
    assert progress == (message_db_id,)


def test_live_ingest_matches_email_case_insensitively_but_only_for_exact_email(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    exact_email = f"{token}-exact@example.com"
    exact_user_id = insert_user(
        conn,
        email=exact_email,
        status="active",
        email_verified_at=ts(1),
    )
    similar_user_id = insert_user(
        conn,
        email=f"{token}-exact-other@example.com",
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    batch = [
        make_record(
            token,
            list_id,
            "exact",
            sent_at=ts(2),
            from_email=exact_email.upper(),
        )
    ]

    ingest.store_batch_live(conn, batch)

    message_db_id, thread_id = fetch_message(conn, batch[0]["message_id"])
    exact_tracking = fetch_tracking_row(conn, exact_user_id, thread_id)
    exact_progress = fetch_progress_row(conn, exact_user_id, thread_id)
    similar_tracking = fetch_tracking_row(conn, similar_user_id, thread_id)
    similar_progress = fetch_progress_row(conn, similar_user_id, thread_id)

    assert exact_tracking is not None
    assert exact_tracking[0] == message_db_id
    assert exact_progress == (message_db_id,)
    assert similar_tracking is None
    assert similar_progress is None


def test_live_ingest_skips_non_matching_disabled_and_unverified_users(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    list_id = insert_list(conn, token)
    active_user_id = insert_user(
        conn,
        email=f"{token}-active@example.com",
        status="active",
        email_verified_at=ts(1),
    )
    disabled_user_id = insert_user(
        conn,
        email=f"{token}-disabled@example.com",
        status="disabled",
        email_verified_at=ts(1),
        disabled_at=ts(2),
    )
    pending_user_id = insert_user(
        conn,
        email=f"{token}-pending@example.com",
        status="pending_verification",
        email_verified_at=None,
    )
    batch = [
        make_record(
            token,
            list_id,
            "nomatch",
            sent_at=ts(2),
            from_email=f"{token}-other@example.com",
        ),
        make_record(
            token,
            list_id,
            "disabled",
            sent_at=ts(3),
            from_email=f"{token}-DISABLED@example.com",
        ),
        make_record(
            token,
            list_id,
            "pending",
            sent_at=ts(4),
            from_email=f"{token}-PENDING@example.com",
        ),
    ]

    ingest.store_batch_live(conn, batch)

    for user_id in (active_user_id, disabled_user_id, pending_user_id):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM thread_tracking WHERE user_id = %s",
                (user_id,),
            )
            tracking_count = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM thread_read_progress WHERE user_id = %s",
                (user_id,),
            )
            progress_count = cur.fetchone()[0]

        assert tracking_count == 0
        assert progress_count == 0


def test_live_ingest_preserves_manual_follow_and_suppression_while_advancing_progress(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    user_email = f"{token}-manual@example.com"
    user_id = insert_user(
        conn,
        email=user_email,
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    root = make_record(
        token,
        list_id,
        "root",
        sent_at=ts(2),
        from_email=f"{token}-other@example.com",
    )
    ingest.store_batch_live(conn, [root])

    root_db_id, thread_id = fetch_message(conn, root["message_id"])
    manual_followed_at = ts(3)
    suppressed_at = ts(4)
    with conn.cursor() as cur:
        cur.execute(
            """
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
            VALUES (%s, %s, %s, %s, NULL, %s, %s, %s)
            """,
            (
                user_id,
                thread_id,
                root_db_id,
                manual_followed_at,
                suppressed_at,
                manual_followed_at,
                manual_followed_at,
            ),
        )
        cur.execute(
            """
            INSERT INTO thread_read_progress (
                user_id,
                thread_id,
                last_read_message_id,
                updated_at
            )
            VALUES (%s, %s, %s, %s)
            """,
            (user_id, thread_id, root_db_id, manual_followed_at),
        )
    conn.commit()

    reply = make_record(
        token,
        list_id,
        "reply",
        sent_at=ts(5),
        from_email=user_email.upper(),
        in_reply_to=root["message_id"],
        refs=[root["message_id"]],
    )
    ingest.store_batch_live(conn, [reply])

    reply_db_id, _ = fetch_message(conn, reply["message_id"])
    tracking = fetch_tracking_row(conn, user_id, thread_id)
    progress = fetch_progress_row(conn, user_id, thread_id)

    assert tracking is not None
    assert tracking[0] == reply_db_id
    assert tracking[1] == manual_followed_at
    assert tracking[2] is not None
    assert tracking[3] == suppressed_at
    assert progress == (reply_db_id,)


def test_live_ingest_keeps_progress_when_existing_row_is_already_ahead(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    user_email = f"{token}-ahead@example.com"
    user_id = insert_user(
        conn,
        email=user_email,
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    root = make_record(
        token,
        list_id,
        "root",
        sent_at=ts(2),
        from_email=user_email,
    )
    ingest.store_batch_live(conn, [root])

    root_db_id, thread_id = fetch_message(conn, root["message_id"])
    later = make_record(
        token,
        list_id,
        "later",
        sent_at=ts(5),
        from_email=f"{token}-other@example.com",
        in_reply_to=root["message_id"],
        refs=[root["message_id"]],
    )
    ingest.store_batch_live(conn, [later])
    later_db_id, _ = fetch_message(conn, later["message_id"])

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE thread_read_progress
            SET last_read_message_id = %s, updated_at = %s
            WHERE user_id = %s AND thread_id = %s
            """,
            (later_db_id, ts(6), user_id, thread_id),
        )
    conn.commit()

    backdated_reply = make_record(
        token,
        list_id,
        "backdated",
        sent_at=ts(4),
        from_email=user_email.upper(),
        in_reply_to=root["message_id"],
        refs=[root["message_id"]],
    )
    ingest.store_batch_live(conn, [backdated_reply])

    backdated_reply_db_id, _ = fetch_message(conn, backdated_reply["message_id"])
    tracking = fetch_tracking_row(conn, user_id, thread_id)
    progress = fetch_progress_row(conn, user_id, thread_id)

    assert tracking is not None
    assert tracking[0] == backdated_reply_db_id
    assert tracking[2] is not None
    assert progress == (later_db_id,)
    assert root_db_id != backdated_reply_db_id


def test_live_ingest_rerun_is_idempotent_for_existing_messages(ingest, live_ingest_db):
    conn, token = live_ingest_db
    user_email = f"{token}-rerun@example.com"
    user_id = insert_user(
        conn,
        email=user_email,
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    batch = [
        make_record(
            token,
            list_id,
            "root",
            sent_at=ts(2),
            from_email=user_email,
        )
    ]

    ingest.store_batch_live(conn, batch)
    first_message_db_id, thread_id = fetch_message(conn, batch[0]["message_id"])

    ingest.store_batch_live(conn, batch)

    tracking = fetch_tracking_row(conn, user_id, thread_id)
    progress = fetch_progress_row(conn, user_id, thread_id)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM thread_tracking WHERE user_id = %s AND thread_id = %s",
            (user_id, thread_id),
        )
        tracking_count = cur.fetchone()[0]
        cur.execute(
            "SELECT count(*) FROM thread_read_progress WHERE user_id = %s AND thread_id = %s",
            (user_id, thread_id),
        )
        progress_count = cur.fetchone()[0]

    assert tracking_count == 1
    assert progress_count == 1
    assert tracking is not None
    assert tracking[0] == first_message_db_id
    assert progress == (first_message_db_id,)


def test_historical_ingest_backfill_keeps_matching_participation_quiet(
    ingest, live_ingest_db
):
    conn, token = live_ingest_db
    user_email = f"{token}-historical@example.com"
    user_id = insert_user(
        conn,
        email=user_email,
        status="active",
        email_verified_at=ts(1),
    )
    list_id = insert_list(conn, token)
    batch = [
        make_record(
            token,
            list_id,
            "root",
            sent_at=ts(2),
            from_email=user_email.upper(),
        )
    ]

    ingest.store_batch_backfill(conn, batch)

    _, thread_id = fetch_message(conn, batch[0]["message_id"])
    assert fetch_tracking_row(conn, user_id, thread_id) is None
    assert fetch_progress_row(conn, user_id, thread_id) is None
