--
-- PostgreSQL database dump
--

\restrict HxZLEY3gI1j4UJTdc76cJORAYZTy4acXpkr1YpOt251tfB1ncyXBPj9MfceD54I

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.6

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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: has_client_membership(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_client_membership(c uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select exists (
    select 1 from public.client_members cm
    where cm.user_id = auth.uid() and cm.client_id = c
  );
$$;


--
-- Name: is_member_of(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_member_of(c uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.client_members m
    where m.client_id = c
      and m.user_id = auth.uid()
  );
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text,
    role_id uuid,
    upload_ts timestamp without time zone DEFAULT now(),
    status text,
    interview_status text,
    resume_url text,
    analysis_summary jsonb,
    interview_video_url text,
    created_at timestamp without time zone DEFAULT now(),
    candidate_id text,
    first_name text,
    last_name text,
    phone text,
    verified boolean DEFAULT false,
    otp_verified_at timestamp without time zone,
    client_id uuid
);


--
-- Name: client_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    name text,
    CONSTRAINT client_invites_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: client_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_members (
    client_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    CONSTRAINT client_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT valid_email CHECK ((email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::text))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id text NOT NULL,
    email text,
    name text,
    conversation_id text NOT NULL,
    conversation_url text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    completed_at timestamp without time zone,
    interview_video_url text,
    status text,
    duration_seconds integer
);


--
-- Name: digest_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digest_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid,
    sent_at timestamp with time zone DEFAULT now(),
    email text NOT NULL
);


--
-- Name: interviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid,
    video_url text,
    transcript text,
    analysis jsonb,
    status text,
    tavus_application_id text,
    role_id uuid,
    rubric jsonb,
    client_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    transcript_url text,
    analysis_url text
);


--
-- Name: otp_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_email text NOT NULL,
    phone text,
    code text NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL,
    used boolean DEFAULT false,
    used_at timestamp with time zone
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid,
    resume_score numeric,
    interview_score numeric,
    overall_score numeric,
    report_url text,
    created_at timestamp without time zone DEFAULT now(),
    resume_breakdown jsonb,
    interview_breakdown jsonb,
    analysis jsonb,
    candidate_external_id text,
    client_id uuid,
    role_id uuid
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    title text,
    description text,
    rubric jsonb,
    interview_type text,
    created_at timestamp with time zone DEFAULT timezone('America/Chicago'::text, now()) NOT NULL,
    interview_expiration timestamp without time zone,
    max_candidates integer,
    slug_or_token text,
    job_description_url text,
    manual_questions text,
    kb_document_id text,
    job_description_text text
);


--
-- Name: role_candidate_counts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.role_candidate_counts AS
 SELECT r.id AS role_id,
    r.title,
    count(c.*) AS candidate_count
   FROM (public.roles r
     LEFT JOIN public.candidates c ON ((c.role_id = r.id)))
  GROUP BY r.id, r.title;


--
-- Name: v_latest_otp_per_email_role; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_latest_otp_per_email_role AS
 SELECT DISTINCT ON (candidate_email, role_id) candidate_email,
    role_id,
    code,
    used,
    expires_at,
    created_at,
    id
   FROM public.otp_tokens
  ORDER BY candidate_email, role_id, created_at DESC;


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: client_invites client_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_invites
    ADD CONSTRAINT client_invites_pkey PRIMARY KEY (id);


--
-- Name: client_invites client_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_invites
    ADD CONSTRAINT client_invites_token_key UNIQUE (token);


--
-- Name: client_members client_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_members
    ADD CONSTRAINT client_members_pkey PRIMARY KEY (client_id, user_id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: digest_logs digest_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digest_logs
    ADD CONSTRAINT digest_logs_pkey PRIMARY KEY (id);


--
-- Name: interviews interviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_pkey PRIMARY KEY (id);


--
-- Name: otp_tokens otp_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_tokens
    ADD CONSTRAINT otp_tokens_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: roles roles_slug_or_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_slug_or_token_key UNIQUE (slug_or_token);


--
-- Name: idx_client_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_members_user_id ON public.client_members USING btree (user_id);


--
-- Name: idx_interviews_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_interviews_client_id ON public.interviews USING btree (client_id);


--
-- Name: idx_otp_candidate_email_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_candidate_email_created_at ON public.otp_tokens USING btree (candidate_email, created_at DESC);


--
-- Name: idx_otp_tokens_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_tokens_code ON public.otp_tokens USING btree (code);


--
-- Name: idx_otp_tokens_email_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_tokens_email_role ON public.otp_tokens USING btree (candidate_email, role_id, created_at DESC);


--
-- Name: idx_reports_candidate_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_candidate_external_id ON public.reports USING btree (candidate_external_id);


--
-- Name: idx_reports_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_role_id ON public.reports USING btree (role_id);


--
-- Name: idx_roles_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_client_id ON public.roles USING btree (client_id);


--
-- Name: idx_roles_kb_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_kb_document_id ON public.roles USING btree (kb_document_id);


--
-- Name: reports_candidate_role_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_candidate_role_created_idx ON public.reports USING btree (candidate_id, role_id, created_at DESC);


--
-- Name: uniq_interviews_candidate_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_interviews_candidate_role ON public.interviews USING btree (candidate_id, role_id);


--
-- Name: interviews set_updated_at_interviews; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_interviews BEFORE UPDATE ON public.interviews FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: candidates candidates_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: client_invites client_invites_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_invites
    ADD CONSTRAINT client_invites_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_members client_members_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_members
    ADD CONSTRAINT client_members_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: digest_logs digest_logs_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digest_logs
    ADD CONSTRAINT digest_logs_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: interviews interviews_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: interviews interviews_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: interviews interviews_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: reports reports_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: roles roles_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: candidates Client can insert candidates for their roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can insert candidates for their roles" ON public.candidates FOR INSERT WITH CHECK ((client_id = auth.uid()));


--
-- Name: reports Client can insert reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can insert reports" ON public.reports FOR INSERT WITH CHECK ((client_id = auth.uid()));


--
-- Name: interviews Client can insert their own interviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can insert their own interviews" ON public.interviews FOR INSERT WITH CHECK ((client_id = auth.uid()));


--
-- Name: roles Client can insert their own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can insert their own roles" ON public.roles FOR INSERT WITH CHECK ((client_id = auth.uid()));


--
-- Name: candidates Client can read their own candidates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can read their own candidates" ON public.candidates FOR SELECT USING ((client_id = auth.uid()));


--
-- Name: roles Client can read their own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can read their own roles" ON public.roles FOR SELECT USING ((client_id = '230f8351-f284-450e-b1d8-adeef448b70a'::uuid));


--
-- Name: interviews Client can view their own interviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can view their own interviews" ON public.interviews FOR SELECT USING ((client_id = auth.uid()));


--
-- Name: reports Client can view their own reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client can view their own reports" ON public.reports FOR SELECT USING ((client_id = auth.uid()));


--
-- Name: interviews select interviews for members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "select interviews for members" ON public.interviews FOR SELECT USING (public.is_member_of(client_id));


--
-- Name: roles select roles for members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "select roles for members" ON public.roles FOR SELECT USING (public.is_member_of(client_id));


--
-- PostgreSQL database dump complete
--

\unrestrict HxZLEY3gI1j4UJTdc76cJORAYZTy4acXpkr1YpOt251tfB1ncyXBPj9MfceD54I

