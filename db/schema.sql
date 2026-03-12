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
-- Name: _normalize_subject(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._normalize_subject(subject text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT trim(regexp_replace(subject, '^(Re|Fwd?)\s*:\s*', '', 'gi'))
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
    sent_at_approx boolean DEFAULT false NOT NULL
);


--
-- Name: analytics_by_dow; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_dow AS
 SELECT (EXTRACT(dow FROM sent_at))::integer AS dow,
    count(*) AS messages
   FROM public.messages
  WHERE ((sent_at_approx = false) AND (sent_at IS NOT NULL))
  GROUP BY ((EXTRACT(dow FROM sent_at))::integer)
  WITH NO DATA;


--
-- Name: analytics_by_hour; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_hour AS
 SELECT (EXTRACT(hour FROM sent_at))::integer AS hour,
    count(*) AS messages
   FROM public.messages
  WHERE ((sent_at_approx = false) AND (sent_at IS NOT NULL))
  GROUP BY ((EXTRACT(hour FROM sent_at))::integer)
  WITH NO DATA;


--
-- Name: analytics_by_month; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_by_month AS
 SELECT (EXTRACT(year FROM sent_at))::integer AS year,
    (EXTRACT(month FROM sent_at))::integer AS month,
    count(*) AS messages
   FROM public.messages
  WHERE ((sent_at_approx = false) AND (sent_at IS NOT NULL))
  GROUP BY ((EXTRACT(year FROM sent_at))::integer), ((EXTRACT(month FROM sent_at))::integer)
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
    message_count integer DEFAULT 1 NOT NULL
);


--
-- Name: analytics_summary; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_summary AS
 SELECT (1)::smallint AS singleton_id,
    ( SELECT count(*) AS count
           FROM public.messages) AS total_messages,
    ( SELECT count(*) AS count
           FROM public.threads) AS total_threads,
    ( SELECT count(DISTINCT messages.from_email) AS count
           FROM public.messages) AS unique_senders,
    ( SELECT count(DISTINCT date_trunc('month'::text, messages.sent_at)) AS count
           FROM public.messages
          WHERE ((messages.sent_at_approx = false) AND (messages.sent_at IS NOT NULL))) AS months_ingested
  WITH NO DATA;


--
-- Name: analytics_top_senders; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.analytics_top_senders AS
 SELECT from_name,
    from_email,
    count(*) AS message_count
   FROM public.messages
  GROUP BY from_name, from_email
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
    content text
);


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
-- Name: lists id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists ALTER COLUMN id SET DEFAULT nextval('public.lists_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: people id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people ALTER COLUMN id SET DEFAULT nextval('public.people_id_seq'::regclass);


--
-- Name: people_emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails ALTER COLUMN id SET DEFAULT nextval('public.people_emails_id_seq'::regclass);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


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
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (thread_id);


--
-- Name: analytics_by_dow_dow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_dow_dow_idx ON public.analytics_by_dow USING btree (dow);


--
-- Name: analytics_by_hour_hour_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_hour_hour_idx ON public.analytics_by_hour USING btree (hour);


--
-- Name: analytics_by_month_year_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_by_month_year_month_idx ON public.analytics_by_month USING btree (year, month);


--
-- Name: analytics_summary_singleton_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_summary_singleton_idx ON public.analytics_summary USING btree (singleton_id);


--
-- Name: analytics_top_senders_count_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_top_senders_count_idx ON public.analytics_top_senders USING btree (message_count DESC, from_email, from_name);


--
-- Name: analytics_top_senders_name_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analytics_top_senders_name_email_idx ON public.analytics_top_senders USING btree (from_name, from_email);


--
-- Name: idx_attachments_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachments_message_id ON public.attachments USING btree (message_id);


--
-- Name: idx_messages_from_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_from_email ON public.messages USING btree (from_email);


--
-- Name: idx_messages_in_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_in_reply_to ON public.messages USING btree (in_reply_to);


--
-- Name: idx_messages_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_sent_at ON public.messages USING btree (sent_at);


--
-- Name: idx_messages_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_thread_id ON public.messages USING btree (thread_id);


--
-- Name: idx_people_emails_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_people_emails_person_id ON public.people_emails USING btree (person_id);


--
-- Name: idx_threads_last_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_last_activity ON public.threads USING btree (last_activity_at);


--
-- Name: idx_threads_list_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_list_id ON public.threads USING btree (list_id);


--
-- Name: attachments attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: messages messages_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id);


--
-- Name: people_emails people_emails_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people_emails
    ADD CONSTRAINT people_emails_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id);


--
-- Name: threads threads_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id);


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
    ('20260312000005');
