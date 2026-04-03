\restrict dbmate

-- Dumped from database version 18.3 (Debian 18.3-1.pgdg13+1)
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pageinspect; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pageinspect WITH SCHEMA public;


--
-- Name: EXTENSION pageinspect; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pageinspect IS 'inspect the contents of database pages at a low level';


--
-- Name: pg_textsearch; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_textsearch WITH SCHEMA public;


--
-- Name: EXTENSION pg_textsearch; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_textsearch IS 'Full-text search with BM25 ranking';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: _normalize_auth_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._normalize_auth_email() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.email := lower(NEW.email);
    RETURN NEW;
END;
$$;


--
-- Name: _normalize_subject(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._normalize_subject(subject text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT trim(regexp_replace(subject, '^(Re|Fwd?)\s*:\s*', '', 'gi'))
$$;


--
-- Name: _revoke_auth_sessions_for_disabled_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._revoke_auth_sessions_for_disabled_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE auth_sessions
    SET revoked_at = now()
    WHERE user_id = NEW.id
      AND revoked_at IS NULL;

    RETURN NEW;
END;
$$;


--
-- Name: _set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        NEW.updated_at := now();
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: refresh_analytics_views(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_analytics_views() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    REFRESH MATERIALIZED VIEW analytics_summary;
    REFRESH MATERIALIZED VIEW analytics_by_month;
    REFRESH MATERIALIZED VIEW analytics_top_senders;
    REFRESH MATERIALIZED VIEW analytics_by_hour;
    REFRESH MATERIALIZED VIEW analytics_by_dow;
    REFRESH MATERIALIZED VIEW analytics_messages_last_24h;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id bigint NOT NULL,
    message_id text NOT NULL,
    thread_id text NOT NULL,
    list_id integer NOT NULL,
    sent_at timestamp with time zone,
    from_name text,
    from_email text,
    subject text,
    in_reply_to text,
    refs text[],
    body text,
    sent_at_approx boolean DEFAULT false NOT NULL,
    archive_month date,
    body_search text GENERATED ALWAYS AS ("left"(COALESCE(body, ''::text), 200000)) STORED
);


--
-- Name: analytics_by_dow; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_dow AS
 SELECT list_id,
    dow,
    count(*) AS messages
   FROM ( SELECT messages.list_id,
            (EXTRACT(dow FROM messages.sent_at))::integer AS dow
           FROM public.messages
          WHERE ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL))) sub
  GROUP BY GROUPING SETS ((list_id, dow), (dow))
  WITH NO DATA;


--
-- Name: analytics_by_hour; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_hour AS
 SELECT list_id,
    hour,
    count(*) AS messages
   FROM ( SELECT messages.list_id,
            (EXTRACT(hour FROM messages.sent_at))::integer AS hour
           FROM public.messages
          WHERE ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL))) sub
  GROUP BY GROUPING SETS ((list_id, hour), (hour))
  WITH NO DATA;


--
-- Name: analytics_by_month; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_month AS
 SELECT list_id,
    year,
    month,
    count(*) AS messages
   FROM ( SELECT messages.list_id,
            (EXTRACT(year FROM messages.sent_at))::integer AS year,
            (EXTRACT(month FROM messages.sent_at))::integer AS month
           FROM public.messages
          WHERE ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL))) sub
  GROUP BY GROUPING SETS ((list_id, year, month), (year, month))
  WITH NO DATA;


--
-- Name: analytics_messages_last_24h; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_messages_last_24h AS
 SELECT (1)::smallint AS singleton_id,
    count(*) AS messages
   FROM public.messages
  WHERE ((sent_at IS NOT NULL) AND (sent_at >= (now() - '24:00:00'::interval)))
  WITH NO DATA;


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    thread_id text NOT NULL,
    list_id integer NOT NULL,
    subject text,
    started_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    message_count integer DEFAULT 1 NOT NULL,
    id text NOT NULL
);


--
-- Name: analytics_summary; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_summary AS
 SELECT m_agg.list_id,
    COALESCE(m_agg.total_messages, (0)::bigint) AS total_messages,
    COALESCE(t_agg.total_threads, (0)::bigint) AS total_threads,
    COALESCE(m_agg.unique_senders, (0)::bigint) AS unique_senders,
    COALESCE(m_agg.months_ingested, (0)::bigint) AS months_ingested,
    COALESCE(m_agg.months_set, '{}'::text[]) AS months_set
   FROM (( SELECT messages.list_id,
            count(*) AS total_messages,
            count(DISTINCT messages.from_email) AS unique_senders,
            count(DISTINCT
                CASE
                    WHEN ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL)) THEN date_trunc('month'::text, messages.sent_at)
                    ELSE NULL::timestamp with time zone
                END) AS months_ingested,
            COALESCE(array_agg(DISTINCT to_char(date_trunc('month'::text, messages.sent_at), 'YYYY-MM'::text)) FILTER (WHERE ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL))), '{}'::text[]) AS months_set
           FROM public.messages
          GROUP BY GROUPING SETS ((messages.list_id), ())) m_agg
     JOIN ( SELECT threads.list_id,
            count(*) AS total_threads
           FROM public.threads
          GROUP BY GROUPING SETS ((threads.list_id), ())) t_agg ON ((COALESCE(m_agg.list_id, '-1'::integer) = COALESCE(t_agg.list_id, '-1'::integer))))
  WITH NO DATA;


--
-- Name: analytics_top_senders; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_top_senders AS
 SELECT list_id,
    from_name,
    from_email,
    count(*) AS message_count
   FROM public.messages
  GROUP BY GROUPING SETS ((list_id, from_name, from_email), (from_name, from_email))
  WITH NO DATA;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id bigint NOT NULL,
    message_id bigint NOT NULL,
    filename text,
    content_type text,
    size_bytes integer,
    content text,
    part_index integer NOT NULL
);


--
-- Name: COLUMN attachments.part_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.part_index IS 'Zero-based position of the extracted attachment within a message MIME part walk.';


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.attachments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip_address inet,
    user_agent text,
    CONSTRAINT auth_sessions_expires_after_create_check CHECK ((expires_at > created_at)),
    CONSTRAINT auth_sessions_last_seen_after_create_check CHECK ((last_seen_at >= created_at)),
    CONSTRAINT auth_sessions_revoked_after_create_check CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))
);


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_sessions_id_seq OWNED BY public.auth_sessions.id;


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT email_verification_tokens_consumed_after_create_check CHECK (((consumed_at IS NULL) OR (consumed_at >= created_at))),
    CONSTRAINT email_verification_tokens_email_lowercase_check CHECK ((email = lower(email))),
    CONSTRAINT email_verification_tokens_expires_after_create_check CHECK ((expires_at > created_at))
);


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_verification_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_verification_tokens_id_seq OWNED BY public.email_verification_tokens.id;


--
-- Name: lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lists (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: lists_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lists_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lists_id_seq OWNED BY public.lists.id;


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT password_reset_tokens_consumed_after_create_check CHECK (((consumed_at IS NULL) OR (consumed_at >= created_at))),
    CONSTRAINT password_reset_tokens_expires_after_create_check CHECK ((expires_at > created_at))
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_tokens_id_seq OWNED BY public.password_reset_tokens.id;


--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: people_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people_emails (
    id integer NOT NULL,
    person_id integer NOT NULL,
    email text NOT NULL
);


--
-- Name: people_emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.people_emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: people_emails_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.people_emails_id_seq OWNED BY public.people_emails.id;


--
-- Name: people_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.people_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: people_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.people_id_seq OWNED BY public.people.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: thread_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_follows (
    user_id bigint NOT NULL,
    thread_id text NOT NULL,
    anchor_message_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: thread_read_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_read_progress (
    user_id bigint CONSTRAINT thread_read_progress_new_user_id_not_null NOT NULL,
    thread_id text CONSTRAINT thread_read_progress_new_thread_id_not_null NOT NULL,
    last_read_message_id bigint CONSTRAINT thread_read_progress_new_last_read_message_id_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT thread_read_progress_new_updated_at_not_null NOT NULL
);


--
-- Name: thread_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_tracking (
    user_id bigint CONSTRAINT thread_tracking_new_user_id_not_null NOT NULL,
    thread_id text CONSTRAINT thread_tracking_new_thread_id_not_null NOT NULL,
    anchor_message_id bigint CONSTRAINT thread_tracking_new_anchor_message_id_not_null NOT NULL,
    manual_followed_at timestamp with time zone,
    participated_at timestamp with time zone,
    participation_suppressed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT thread_tracking_new_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT thread_tracking_new_updated_at_not_null NOT NULL,
    CONSTRAINT thread_tracking_source_check CHECK (((manual_followed_at IS NOT NULL) OR (participated_at IS NOT NULL)))
);


--
-- Name: user_email_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_email_claims (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    email text NOT NULL,
    claim_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_email_claims_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['registration'::text, 'secondary_addition'::text]))),
    CONSTRAINT user_email_claims_email_lowercase_check CHECK ((email = lower(email)))
);


--
-- Name: user_email_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_email_claims_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_email_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_email_claims_id_seq OWNED BY public.user_email_claims.id;


--
-- Name: user_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_emails (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    email text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_emails_email_lowercase_check CHECK ((email = lower(email)))
);


--
-- Name: user_emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_emails_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_emails_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_emails_id_seq OWNED BY public.user_emails.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    display_name text,
    password_hash text NOT NULL,
    status text NOT NULL,
    last_login_at timestamp with time zone,
    disabled_at timestamp with time zone,
    disable_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['pending_verification'::text, 'active'::text, 'disabled'::text]))),
    CONSTRAINT users_status_state_check CHECK ((((status = 'pending_verification'::text) AND (disabled_at IS NULL) AND (disable_reason IS NULL)) OR ((status = 'active'::text) AND (disabled_at IS NULL) AND (disable_reason IS NULL)) OR ((status = 'disabled'::text) AND (disabled_at IS NOT NULL)))),
    CONSTRAINT users_updated_after_create_check CHECK ((updated_at >= created_at))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: auth_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions ALTER COLUMN id SET DEFAULT nextval('public.auth_sessions_id_seq'::regclass);


--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.email_verification_tokens_id_seq'::regclass);


--
-- Name: lists id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists ALTER COLUMN id SET DEFAULT nextval('public.lists_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);


--
-- Name: people id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people ALTER COLUMN id SET DEFAULT nextval('public.people_id_seq'::regclass);


--
-- Name: people_emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails ALTER COLUMN id SET DEFAULT nextval('public.people_emails_id_seq'::regclass);


--
-- Name: user_email_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_claims ALTER COLUMN id SET DEFAULT nextval('public.user_email_claims_id_seq'::regclass);


--
-- Name: user_emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails ALTER COLUMN id SET DEFAULT nextval('public.user_emails_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: lists lists_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_name_key UNIQUE (name);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


--
-- Name: messages messages_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_message_id_key UNIQUE (message_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: people_emails people_emails_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails
    ADD CONSTRAINT people_emails_email_key UNIQUE (email);


--
-- Name: people_emails people_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails
    ADD CONSTRAINT people_emails_pkey PRIMARY KEY (id);


--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: thread_follows thread_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_follows
    ADD CONSTRAINT thread_follows_pkey PRIMARY KEY (user_id, thread_id);


--
-- Name: thread_read_progress thread_read_progress_new_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_read_progress
    ADD CONSTRAINT thread_read_progress_new_pkey PRIMARY KEY (user_id, thread_id);


--
-- Name: thread_tracking thread_tracking_new_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_tracking
    ADD CONSTRAINT thread_tracking_new_pkey PRIMARY KEY (user_id, thread_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (thread_id);


--
-- Name: user_email_claims user_email_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_claims
    ADD CONSTRAINT user_email_claims_pkey PRIMARY KEY (id);


--
-- Name: user_emails user_emails_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails
    ADD CONSTRAINT user_emails_email_key UNIQUE (email);


--
-- Name: user_emails user_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails
    ADD CONSTRAINT user_emails_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: analytics_by_dow_list_dow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_dow_list_dow_idx ON public.analytics_by_dow USING btree (list_id, dow) NULLS NOT DISTINCT;


--
-- Name: analytics_by_hour_list_hour_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_hour_list_hour_idx ON public.analytics_by_hour USING btree (list_id, hour) NULLS NOT DISTINCT;


--
-- Name: analytics_by_month_list_year_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_month_list_year_month_idx ON public.analytics_by_month USING btree (list_id, year, month) NULLS NOT DISTINCT;


--
-- Name: analytics_messages_last_24h_singleton_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_messages_last_24h_singleton_idx ON public.analytics_messages_last_24h USING btree (singleton_id);


--
-- Name: analytics_summary_list_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_summary_list_id_idx ON public.analytics_summary USING btree (list_id) NULLS NOT DISTINCT;


--
-- Name: analytics_top_senders_list_count_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_top_senders_list_count_idx ON public.analytics_top_senders USING btree (list_id, message_count DESC, from_email, from_name);


--
-- Name: analytics_top_senders_list_name_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_top_senders_list_name_email_idx ON public.analytics_top_senders USING btree (list_id, from_name, from_email) NULLS NOT DISTINCT;


--
-- Name: idx_attachments_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachments_message_id ON public.attachments USING btree (message_id);


--
-- Name: idx_attachments_message_part_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_attachments_message_part_index ON public.attachments USING btree (message_id, part_index);


--
-- Name: idx_auth_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_sessions_expires_at ON public.auth_sessions USING btree (expires_at);


--
-- Name: idx_auth_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_sessions_user_id ON public.auth_sessions USING btree (user_id);


--
-- Name: idx_email_verification_tokens_user_email_unconsumed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_email_verification_tokens_user_email_unconsumed ON public.email_verification_tokens USING btree (user_id, email) WHERE (consumed_at IS NULL);


--
-- Name: idx_email_verification_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verification_tokens_user_id ON public.email_verification_tokens USING btree (user_id);


--
-- Name: idx_messages_body_search_bm25; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_body_search_bm25 ON public.messages USING bm25 (body_search) WITH (text_config=english);


--
-- Name: idx_messages_from_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_from_email ON public.messages USING btree (from_email);


--
-- Name: idx_messages_in_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_in_reply_to ON public.messages USING btree (in_reply_to);


--
-- Name: idx_messages_list_archive_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_list_archive_month ON public.messages USING btree (list_id, archive_month);


--
-- Name: idx_messages_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_sent_at ON public.messages USING btree (sent_at);


--
-- Name: idx_messages_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_thread_id ON public.messages USING btree (thread_id);


--
-- Name: idx_messages_thread_id_sent_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_thread_id_sent_at_id ON public.messages USING btree (thread_id, sent_at, id);


--
-- Name: idx_password_reset_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_password_reset_tokens_user_id_unconsumed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_password_reset_tokens_user_id_unconsumed ON public.password_reset_tokens USING btree (user_id) WHERE (consumed_at IS NULL);


--
-- Name: idx_people_emails_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_people_emails_person_id ON public.people_emails USING btree (person_id);


--
-- Name: idx_threads_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_threads_id ON public.threads USING btree (id);


--
-- Name: idx_threads_last_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_last_activity ON public.threads USING btree (last_activity_at);


--
-- Name: idx_threads_list_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_list_id ON public.threads USING btree (list_id);


--
-- Name: idx_threads_page_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_page_order ON public.threads USING btree (last_activity_at DESC NULLS LAST, thread_id);


--
-- Name: idx_threads_subject_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_subject_trgm ON public.threads USING gin (subject public.gin_trgm_ops);


--
-- Name: idx_user_email_claims_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_email_claims_email ON public.user_email_claims USING btree (email);


--
-- Name: idx_user_email_claims_registration_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_email_claims_registration_email ON public.user_email_claims USING btree (email) WHERE (claim_kind = 'registration'::text);


--
-- Name: idx_user_email_claims_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_email_claims_user_email ON public.user_email_claims USING btree (user_id, email);


--
-- Name: idx_user_email_claims_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_email_claims_user_id ON public.user_email_claims USING btree (user_id);


--
-- Name: idx_user_emails_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_emails_user_id ON public.user_emails USING btree (user_id);


--
-- Name: idx_user_emails_user_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_emails_user_primary ON public.user_emails USING btree (user_id) WHERE (is_primary = true);


--
-- Name: email_verification_tokens trg_email_verification_tokens_normalize_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_verification_tokens_normalize_email BEFORE INSERT OR UPDATE OF email ON public.email_verification_tokens FOR EACH ROW EXECUTE FUNCTION public._normalize_auth_email();


--
-- Name: user_email_claims trg_user_email_claims_normalize_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_email_claims_normalize_email BEFORE INSERT OR UPDATE OF email ON public.user_email_claims FOR EACH ROW EXECUTE FUNCTION public._normalize_auth_email();


--
-- Name: user_emails trg_user_emails_normalize_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_emails_normalize_email BEFORE INSERT OR UPDATE OF email ON public.user_emails FOR EACH ROW EXECUTE FUNCTION public._normalize_auth_email();


--
-- Name: users trg_users_revoke_sessions_on_disable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_revoke_sessions_on_disable AFTER UPDATE OF status ON public.users FOR EACH ROW WHEN (((new.status = 'disabled'::text) AND (old.status IS DISTINCT FROM 'disabled'::text))) EXECUTE FUNCTION public._revoke_auth_sessions_for_disabled_user();


--
-- Name: users trg_users_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();


--
-- Name: attachments attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id);


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: people_emails people_emails_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails
    ADD CONSTRAINT people_emails_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id);


--
-- Name: thread_follows thread_follows_anchor_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_follows
    ADD CONSTRAINT thread_follows_anchor_message_id_fkey FOREIGN KEY (anchor_message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: thread_follows thread_follows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_follows
    ADD CONSTRAINT thread_follows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: thread_read_progress thread_read_progress_new_last_read_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_read_progress
    ADD CONSTRAINT thread_read_progress_new_last_read_message_id_fkey FOREIGN KEY (last_read_message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: thread_read_progress thread_read_progress_new_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_read_progress
    ADD CONSTRAINT thread_read_progress_new_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: thread_read_progress thread_read_progress_new_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_read_progress
    ADD CONSTRAINT thread_read_progress_new_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: thread_tracking thread_tracking_new_anchor_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_tracking
    ADD CONSTRAINT thread_tracking_new_anchor_message_id_fkey FOREIGN KEY (anchor_message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: thread_tracking thread_tracking_new_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_tracking
    ADD CONSTRAINT thread_tracking_new_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: thread_tracking thread_tracking_new_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_tracking
    ADD CONSTRAINT thread_tracking_new_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: threads threads_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id);


--
-- Name: user_email_claims user_email_claims_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_claims
    ADD CONSTRAINT user_email_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_emails user_emails_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails
    ADD CONSTRAINT user_emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260301000001'),
    ('20260301000002'),
    ('20260301000003'),
    ('20260301000004'),
    ('20260312000005'),
    ('20260312000006'),
    ('20260312000007'),
    ('20260314000008'),
    ('20260315000009'),
    ('20260315000010'),
    ('20260317000011'),
    ('20260317000012'),
    ('20260317000013'),
    ('20260318000014'),
    ('20260319000015'),
    ('20260320000016'),
    ('20260320000017'),
    ('20260321000018'),
    ('20260321000019'),
    ('20260322000020'),
    ('20260322000021'),
    ('20260323000022'),
    ('20260323000023'),
    ('20260402000024');
