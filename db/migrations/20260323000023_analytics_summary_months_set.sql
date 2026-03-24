-- migrate:up

-- Add months_set column to analytics_summary so multi-list queries can compute
-- accurate months_ingested via set union without hitting the messages table live.
DROP MATERIALIZED VIEW analytics_summary;

CREATE MATERIALIZED VIEW analytics_summary AS
SELECT
    m_agg.list_id,
    COALESCE(m_agg.total_messages, 0)::bigint AS total_messages,
    COALESCE(t_agg.total_threads, 0)::bigint AS total_threads,
    COALESCE(m_agg.unique_senders, 0)::bigint AS unique_senders,
    COALESCE(m_agg.months_ingested, 0)::bigint AS months_ingested,
    COALESCE(m_agg.months_set, '{}') AS months_set
FROM (
    SELECT
        list_id,
        count(*)::bigint AS total_messages,
        count(DISTINCT from_email)::bigint AS unique_senders,
        count(DISTINCT CASE
            WHEN sent_at_approx = false AND sent_at IS NOT NULL
            THEN date_trunc('month', sent_at)
        END)::bigint AS months_ingested,
        COALESCE(
            array_agg(DISTINCT to_char(date_trunc('month', sent_at), 'YYYY-MM'))
                FILTER (WHERE sent_at_approx = false AND sent_at IS NOT NULL),
            '{}'
        ) AS months_set
    FROM messages
    GROUP BY GROUPING SETS ((list_id), ())
) m_agg
JOIN (
    SELECT
        list_id,
        count(*)::bigint AS total_threads
    FROM threads
    GROUP BY GROUPING SETS ((list_id), ())
) t_agg ON COALESCE(m_agg.list_id, -1) = COALESCE(t_agg.list_id, -1);

CREATE UNIQUE INDEX analytics_summary_list_id_idx
    ON analytics_summary (list_id) NULLS NOT DISTINCT;

-- migrate:down

DROP MATERIALIZED VIEW analytics_summary;

CREATE MATERIALIZED VIEW analytics_summary AS
SELECT
    m_agg.list_id,
    COALESCE(m_agg.total_messages, 0)::bigint AS total_messages,
    COALESCE(t_agg.total_threads, 0)::bigint AS total_threads,
    COALESCE(m_agg.unique_senders, 0)::bigint AS unique_senders,
    COALESCE(m_agg.months_ingested, 0)::bigint AS months_ingested
FROM (
    SELECT
        list_id,
        count(*)::bigint AS total_messages,
        count(DISTINCT from_email)::bigint AS unique_senders,
        count(DISTINCT CASE
            WHEN sent_at_approx = false AND sent_at IS NOT NULL
            THEN date_trunc('month', sent_at)
        END)::bigint AS months_ingested
    FROM messages
    GROUP BY GROUPING SETS ((list_id), ())
) m_agg
JOIN (
    SELECT
        list_id,
        count(*)::bigint AS total_threads
    FROM threads
    GROUP BY GROUPING SETS ((list_id), ())
) t_agg ON COALESCE(m_agg.list_id, -1) = COALESCE(t_agg.list_id, -1);

CREATE UNIQUE INDEX analytics_summary_list_id_idx
    ON analytics_summary (list_id) NULLS NOT DISTINCT;
