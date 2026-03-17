-- migrate:up

CREATE MATERIALIZED VIEW analytics_messages_last_24h AS
SELECT
    1::smallint AS singleton_id,
    count(*)::bigint AS messages
FROM messages
WHERE sent_at IS NOT NULL
  AND sent_at >= NOW() - INTERVAL '24 hours';

CREATE UNIQUE INDEX analytics_messages_last_24h_singleton_idx
    ON analytics_messages_last_24h (singleton_id);

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

DROP FUNCTION refresh_analytics_views();
DROP MATERIALIZED VIEW analytics_messages_last_24h;

CREATE FUNCTION refresh_analytics_views() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW analytics_summary;
    REFRESH MATERIALIZED VIEW analytics_by_month;
    REFRESH MATERIALIZED VIEW analytics_top_senders;
    REFRESH MATERIALIZED VIEW analytics_by_hour;
    REFRESH MATERIALIZED VIEW analytics_by_dow;
END;
$$ LANGUAGE plpgsql;
