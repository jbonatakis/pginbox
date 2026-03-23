-- migrate:up

-- Drop existing views so we can recreate with list_id dimension.
-- Global aggregate rows have list_id IS NULL; per-list rows have the specific list_id.
DROP MATERIALIZED VIEW IF EXISTS analytics_by_dow;
DROP MATERIALIZED VIEW IF EXISTS analytics_by_hour;
DROP MATERIALIZED VIEW IF EXISTS analytics_top_senders;
DROP MATERIALIZED VIEW IF EXISTS analytics_by_month;
DROP MATERIALIZED VIEW IF EXISTS analytics_summary;

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

CREATE MATERIALIZED VIEW analytics_by_month AS
SELECT
    list_id,
    year,
    month,
    count(*)::bigint AS messages
FROM (
    SELECT
        list_id,
        extract(year FROM sent_at)::integer AS year,
        extract(month FROM sent_at)::integer AS month
    FROM messages
    WHERE sent_at_approx = false
      AND sent_at IS NOT NULL
) sub
GROUP BY GROUPING SETS ((list_id, year, month), (year, month));

CREATE UNIQUE INDEX analytics_by_month_list_year_month_idx
    ON analytics_by_month (list_id, year, month) NULLS NOT DISTINCT;

CREATE MATERIALIZED VIEW analytics_top_senders AS
SELECT
    list_id,
    from_name,
    from_email,
    count(*)::bigint AS message_count
FROM messages
GROUP BY GROUPING SETS ((list_id, from_name, from_email), (from_name, from_email));

CREATE UNIQUE INDEX analytics_top_senders_list_name_email_idx
    ON analytics_top_senders (list_id, from_name, from_email) NULLS NOT DISTINCT;
CREATE INDEX analytics_top_senders_list_count_idx
    ON analytics_top_senders (list_id, message_count DESC, from_email, from_name);

CREATE MATERIALIZED VIEW analytics_by_hour AS
SELECT
    list_id,
    hour,
    count(*)::bigint AS messages
FROM (
    SELECT
        list_id,
        extract(hour FROM sent_at)::integer AS hour
    FROM messages
    WHERE sent_at_approx = false
      AND sent_at IS NOT NULL
) sub
GROUP BY GROUPING SETS ((list_id, hour), (hour));

CREATE UNIQUE INDEX analytics_by_hour_list_hour_idx
    ON analytics_by_hour (list_id, hour) NULLS NOT DISTINCT;

CREATE MATERIALIZED VIEW analytics_by_dow AS
SELECT
    list_id,
    dow,
    count(*)::bigint AS messages
FROM (
    SELECT
        list_id,
        extract(dow FROM sent_at)::integer AS dow
    FROM messages
    WHERE sent_at_approx = false
      AND sent_at IS NOT NULL
) sub
GROUP BY GROUPING SETS ((list_id, dow), (dow));

CREATE UNIQUE INDEX analytics_by_dow_list_dow_idx
    ON analytics_by_dow (list_id, dow) NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION refresh_analytics_views() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW analytics_summary;
    REFRESH MATERIALIZED VIEW analytics_by_month;
    REFRESH MATERIALIZED VIEW analytics_top_senders;
    REFRESH MATERIALIZED VIEW analytics_by_hour;
    REFRESH MATERIALIZED VIEW analytics_by_dow;
    REFRESH MATERIALIZED VIEW analytics_messages_last_24h;
END;
$$ LANGUAGE plpgsql;

-- migrate:down

DROP MATERIALIZED VIEW analytics_by_dow;
DROP MATERIALIZED VIEW analytics_by_hour;
DROP MATERIALIZED VIEW analytics_top_senders;
DROP MATERIALIZED VIEW analytics_by_month;
DROP MATERIALIZED VIEW analytics_summary;

CREATE MATERIALIZED VIEW analytics_summary AS
SELECT
    1::smallint AS singleton_id,
    (SELECT count(*) FROM messages)::bigint AS total_messages,
    (SELECT count(*) FROM threads)::bigint AS total_threads,
    (SELECT count(DISTINCT from_email) FROM messages)::bigint AS unique_senders,
    (
        SELECT count(DISTINCT date_trunc('month', sent_at))
        FROM messages
        WHERE sent_at_approx = false
          AND sent_at IS NOT NULL
    )::bigint AS months_ingested;

CREATE UNIQUE INDEX analytics_summary_singleton_idx ON analytics_summary (singleton_id);

CREATE MATERIALIZED VIEW analytics_by_month AS
SELECT
    extract(year FROM sent_at)::integer AS year,
    extract(month FROM sent_at)::integer AS month,
    count(*)::bigint AS messages
FROM messages
WHERE sent_at_approx = false
  AND sent_at IS NOT NULL
GROUP BY 1, 2;

CREATE UNIQUE INDEX analytics_by_month_year_month_idx ON analytics_by_month (year, month);

CREATE MATERIALIZED VIEW analytics_top_senders AS
SELECT
    from_name,
    from_email,
    count(*)::bigint AS message_count
FROM messages
GROUP BY from_name, from_email;

CREATE UNIQUE INDEX analytics_top_senders_name_email_idx
    ON analytics_top_senders (from_name, from_email);
CREATE INDEX analytics_top_senders_count_idx
    ON analytics_top_senders (message_count DESC, from_email, from_name);

CREATE MATERIALIZED VIEW analytics_by_hour AS
SELECT
    extract(hour FROM sent_at)::integer AS hour,
    count(*)::bigint AS messages
FROM messages
WHERE sent_at_approx = false
  AND sent_at IS NOT NULL
GROUP BY 1;

CREATE UNIQUE INDEX analytics_by_hour_hour_idx ON analytics_by_hour (hour);

CREATE MATERIALIZED VIEW analytics_by_dow AS
SELECT
    extract(dow FROM sent_at)::integer AS dow,
    count(*)::bigint AS messages
FROM messages
WHERE sent_at_approx = false
  AND sent_at IS NOT NULL
GROUP BY 1;

CREATE UNIQUE INDEX analytics_by_dow_dow_idx ON analytics_by_dow (dow);

CREATE OR REPLACE FUNCTION refresh_analytics_views() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW analytics_summary;
    REFRESH MATERIALIZED VIEW analytics_by_month;
    REFRESH MATERIALIZED VIEW analytics_top_senders;
    REFRESH MATERIALIZED VIEW analytics_by_hour;
    REFRESH MATERIALIZED VIEW analytics_by_dow;
    REFRESH MATERIALIZED VIEW analytics_messages_last_24h;
END;
$$ LANGUAGE plpgsql;
