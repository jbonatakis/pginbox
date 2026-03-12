-- migrate:up

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

CREATE FUNCTION refresh_analytics_views() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW analytics_summary;
    REFRESH MATERIALIZED VIEW analytics_by_month;
    REFRESH MATERIALIZED VIEW analytics_top_senders;
    REFRESH MATERIALIZED VIEW analytics_by_hour;
    REFRESH MATERIALIZED VIEW analytics_by_dow;
END;
$$ LANGUAGE plpgsql;

-- migrate:down

DROP FUNCTION refresh_analytics_views();
DROP MATERIALIZED VIEW analytics_by_dow;
DROP MATERIALIZED VIEW analytics_by_hour;
DROP MATERIALIZED VIEW analytics_top_senders;
DROP MATERIALIZED VIEW analytics_by_month;
DROP MATERIALIZED VIEW analytics_summary;
