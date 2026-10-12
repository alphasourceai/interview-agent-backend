-- LOCAL/unmounted. No key/provider/job is seeded, no message is sent.
begin;
create table public.membership_v2_delivery_keys (
 environment text not null check(environment in ('dev','staging','production')),
 key_id text not null check(key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
 physical_key_fingerprint text not null unique check(physical_key_fingerprint ~ '^[0-9a-f]{64}$'),
 seal_limit integer not null check(seal_limit between 1 and 1000000),
 used_count integer not null default 0 check(used_count between 0 and seal_limit),
 retired boolean not null default false,created_at timestamptz not null check(isfinite(created_at)),
 primary key(environment,key_id)
);
create function public.membership_v2_guard_delivery_key()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then
  if new.used_count<>0 or new.retired then raise exception 'delivery_key_denied';end if;
  new.created_at:=clock_timestamp();
 elsif new.environment is distinct from old.environment or new.key_id is distinct from old.key_id
  or new.physical_key_fingerprint is distinct from old.physical_key_fingerprint or new.seal_limit is distinct from old.seal_limit
  or new.created_at is distinct from old.created_at or old.retired
  or not ((new.used_count=old.used_count+1 and new.retired=old.retired)
   or (new.used_count=old.used_count and new.retired and not old.retired)) then
  raise exception 'delivery_key_transition_denied';
 end if;return new;
end $$;
create trigger membership_v2_guard_delivery_key before insert or update on public.membership_v2_delivery_keys
 for each row execute function public.membership_v2_guard_delivery_key();
create trigger membership_v2_delivery_keys_no_delete before delete on public.membership_v2_delivery_keys
 for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_delivery_keys_no_truncate before truncate on public.membership_v2_delivery_keys
 for each statement execute function public.membership_v2_reject_mutation();
create table public.membership_v2_delivery_jobs (
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 purpose text not null check(purpose in ('sales_email_link_v1','retail_signer_v2')),
 source_id uuid not null references public.membership_v2_sales_prospects(id) on delete restrict on update restrict,
 document_id uuid references public.membership_v2_issued_documents(id) on delete restrict on update restrict,
 subject_id uuid generated always as(coalesce(document_id,source_id)) stored,
 scope_id uuid not null references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
 issuer_user_id uuid not null references public.sales_reps(user_id) on delete restrict on update restrict,
 environment text not null,key_id text not null,nonce text not null,
 sealed_envelope jsonb not null check(octet_length(sealed_envelope::text)<=4096),
 queued_at timestamptz not null check(isfinite(queued_at)),
 check((purpose='sales_email_link_v1' and document_id is null) or (purpose='retail_signer_v2' and document_id is not null)),
 foreign key(environment,key_id) references public.membership_v2_delivery_keys(environment,key_id) on delete restrict on update restrict,
 unique(purpose,subject_id),unique(environment,key_id,nonce)
);
create index membership_v2_delivery_jobs_source_idx on public.membership_v2_delivery_jobs(source_id);
create index membership_v2_delivery_jobs_document_idx on public.membership_v2_delivery_jobs(document_id) where document_id is not null;
create index membership_v2_delivery_jobs_scope_idx on public.membership_v2_delivery_jobs(scope_id);
create index membership_v2_delivery_jobs_issuer_idx on public.membership_v2_delivery_jobs(issuer_user_id);
create function public.membership_v2_valid_delivery_envelope(p_envelope jsonb,p_binding jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text;
begin
 if jsonb_typeof(p_envelope) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_envelope))<>6
  or not(p_envelope ?& array['protocol','key_id','binding','nonce','ciphertext','tag']) then return false;end if;
 foreach k in array array['protocol','key_id','nonce','ciphertext','tag'] loop
  if jsonb_typeof(p_envelope->k) is distinct from 'string' then return false;end if;
 end loop;
 return coalesce(p_envelope->>'protocol'='membership_capability_envelope_v1'
  and p_envelope->>'key_id' ~ '^[A-Za-z0-9._-]{1,64}$' and p_envelope->'binding'=p_binding
  and p_envelope->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and p_envelope->>'ciphertext' ~ '^[A-Za-z0-9_-]{57}[AQgw]$'
  and p_envelope->>'tag' ~ '^[A-Za-z0-9_-]{21}[AQgw]$',false);
end $$;
create function public.membership_v2_guard_delivery_job()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.membership_v2_sales_prospects;d public.membership_v2_issued_documents;
 c public.membership_v2_sales_email_challenges;q public.membership_v2_quote_drafts;g public.membership_v2_legal_gates;
 k public.membership_v2_delivery_keys;expected jsonb;n timestamptz;
begin
 select * into s from public.membership_v2_sales_prospects where id=new.source_id;
 if not found then raise exception 'delivery_job_denied';end if;
 perform 1 from public.sales_reps where user_id=s.issuer_user_id and (new.purpose='retail_signer_v2' or active) for share;
 if not found then raise exception 'delivery_job_denied';end if;
 perform 1 from public.membership_v2_sales_prospect_heads where scope_id=s.scope_id and current_source_id=s.id for update;
 if not found then raise exception 'delivery_job_denied';end if;
 if new.purpose='sales_email_link_v1' and new.document_id is null then
  if not exists(select 1 from public.membership_v2_sales_prospects where id=s.id
   and xmin=pg_current_xact_id()::xid and created_at>=transaction_timestamp()) then raise exception 'delivery_job_denied';end if;
  select * into strict c from public.membership_v2_sales_email_challenges where source_id=s.id and source_fingerprint=s.source_fingerprint;
  select * into q from public.membership_v2_quote_drafts where id=s.quote_id and quote_digest=s.quote_digest and scope_id=s.scope_id
   and issuer_user_id=s.issuer_user_id and original_salesperson_user_id=s.issuer_user_id and audience='sales' and client_id is null and billing_owner_user_id is null;
  if not found or not exists(select 1 from public.membership_v2_sales_email_challenges where source_id=s.id
   and xmin=pg_current_xact_id()::xid) or c.issued_at is distinct from s.created_at
   or c.expires_at is distinct from least(s.created_at+interval '10 minutes',q.expires_at) then raise exception 'delivery_job_denied';end if;
  expected:=jsonb_build_object('purpose',new.purpose,'environment',new.environment,'source_id',s.id,
   'source_fingerprint',s.source_fingerprint,'buyer_email',s.buyer_snapshot->>'buyer_email','token_hash',c.token_hash);
 elsif new.purpose='retail_signer_v2' and new.document_id is not null then
  select * into d from public.membership_v2_issued_documents where id=new.document_id and source_id=s.id
   and source_fingerprint=s.source_fingerprint and scope_id=s.scope_id and issuer_user_id=s.issuer_user_id
   and xmin=pg_current_xact_id()::xid and issued_at>=transaction_timestamp();
  if not found then raise exception 'delivery_job_denied';end if;
  select * into g from public.membership_v2_legal_gates where version=d.legal_version for share;
  if not found or g.revoked then raise exception 'delivery_job_denied';end if;
  expected:=jsonb_build_object('purpose',new.purpose,'environment',new.environment,'document_id',d.id,
   'source_fingerprint',d.source_fingerprint,'buyer_email',d.source_snapshot->'buyer'->>'buyer_email',
   'legal_version',d.legal_version,'html_sha256',d.html_sha256,'preview_pdf_sha256',d.preview_pdf_sha256,'token_hash',d.signer_token_hash);
 else raise exception 'delivery_job_denied';end if;
 if not public.membership_v2_valid_delivery_envelope(new.sealed_envelope,expected) then raise exception 'delivery_job_denied';end if;
 if(new.key_id is not null and new.key_id is distinct from new.sealed_envelope->>'key_id')
  or(new.nonce is not null and new.nonce is distinct from new.sealed_envelope->>'nonce') then raise exception 'delivery_job_denied';end if;
 new.key_id:=new.sealed_envelope->>'key_id';new.nonce:=new.sealed_envelope->>'nonce';
 select * into k from public.membership_v2_delivery_keys where environment=new.environment and key_id=new.key_id for update;
 if not found or k.retired or k.used_count>=k.seal_limit then raise exception 'delivery_key_denied';end if;
 n:=clock_timestamp();
 if(new.purpose='sales_email_link_v1' and(s.created_at>n or c.issued_at>n or c.expires_at<=n or q.issued_at>n or q.expires_at<=n))
  or(new.purpose='retail_signer_v2' and(d.issued_at>n or d.expires_at<=n)) then raise exception 'delivery_job_denied';end if;
 update public.membership_v2_delivery_keys set used_count=used_count+1 where environment=k.environment and key_id=k.key_id;
 new.scope_id:=s.scope_id;new.issuer_user_id:=s.issuer_user_id;new.queued_at:=n;return new;
end $$;
create trigger membership_v2_guard_delivery_job before insert on public.membership_v2_delivery_jobs
 for each row execute function public.membership_v2_guard_delivery_job();
create function public.membership_v2_register_source_and_delivery(p_source jsonb,p_job uuid,p_envelope jsonb)
returns table(job_id uuid,source_id uuid,document_id uuid,purpose text,environment text,queued_at timestamptz)
language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.membership_v2_sales_prospects;j public.membership_v2_delivery_jobs;
begin
 if jsonb_typeof(p_source) is distinct from 'object' or(select count(*) from jsonb_object_keys(p_source))<>10
  or not(p_source ?& array['id','actor','scope','quote','quote_digest','previous','buyer','canonical','fingerprint','token_hash']) then
  raise exception 'delivery_job_denied';end if;
 select * into strict s from public.membership_v2_register_sales_prospect((p_source->>'id')::uuid,(p_source->>'actor')::uuid,
  (p_source->>'scope')::uuid,(p_source->>'quote')::uuid,p_source->>'quote_digest',(p_source->>'previous')::uuid,p_source->'buyer',
  p_source->>'canonical',p_source->>'fingerprint',p_source->>'token_hash');
 insert into public.membership_v2_delivery_jobs(id,purpose,source_id,environment,sealed_envelope)
  values(p_job,'sales_email_link_v1',s.id,p_envelope->'binding'->>'environment',p_envelope) returning * into j;
 return query select j.id,j.source_id,j.document_id,j.purpose,j.environment,j.queued_at;
end $$;
create function public.membership_v2_issue_document_and_delivery(p_document jsonb,p_job uuid,p_envelope jsonb)
returns table(job_id uuid,source_id uuid,document_id uuid,purpose text,environment text,queued_at timestamptz)
language plpgsql security invoker set search_path=pg_catalog as $$
declare d public.membership_v2_issued_documents;j public.membership_v2_delivery_jobs;
begin
 select * into strict d from public.membership_v2_issue_document(p_document);
 insert into public.membership_v2_delivery_jobs(id,purpose,source_id,document_id,environment,sealed_envelope)
  values(p_job,'retail_signer_v2',d.source_id,d.id,p_envelope->'binding'->>'environment',p_envelope) returning * into j;
 return query select j.id,j.source_id,j.document_id,j.purpose,j.environment,j.queued_at;
end $$;
create table public.membership_v2_delivery_attempts (
 job_id uuid primary key references public.membership_v2_delivery_jobs(id) on delete restrict on update restrict,
 attempt_id uuid not null unique check(attempt_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 disposition text not null check(disposition in ('send','skip_obsolete')),claimed_at timestamptz not null check(isfinite(claimed_at)),
 unique(job_id,attempt_id)
);
create table public.membership_v2_delivery_results (
 job_id uuid primary key,attempt_id uuid not null,
 outcome text not null check(outcome in ('accepted_by_provider','rejected','held_unknown')),provider_reference text,
 recorded_at timestamptz not null check(isfinite(recorded_at)),
 foreign key(job_id,attempt_id) references public.membership_v2_delivery_attempts(job_id,attempt_id) on delete restrict on update restrict,
 check((outcome='accepted_by_provider' and provider_reference is not null and provider_reference ~ '^[A-Za-z0-9._:-]{1,200}$')
  or(outcome in ('rejected','held_unknown') and provider_reference is null))
);
-- Parent-compatible lock order. Native time AFTER all waits, no network IO.
create function public.membership_v2_delivery_admission(p_job uuid)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare j public.membership_v2_delivery_jobs;s public.membership_v2_sales_prospects;d public.membership_v2_issued_documents;
 c public.membership_v2_sales_email_challenges;q public.membership_v2_quote_drafts;g public.membership_v2_legal_gates;
 k public.membership_v2_delivery_keys;n timestamptz;obsolete boolean:=false;
begin
 select * into j from public.membership_v2_delivery_jobs where id=p_job;
 if not found then raise exception 'delivery_claim_denied';end if;
 select * into strict s from public.membership_v2_sales_prospects where id=j.source_id;
 perform 1 from public.sales_reps where user_id=j.issuer_user_id and(j.purpose='retail_signer_v2' or active) for share;
 if not found then raise exception 'delivery_claim_denied';end if;
 perform 1 from public.membership_v2_sales_prospect_heads where scope_id=j.scope_id and current_source_id=s.id for share;
 if not found then raise exception 'delivery_claim_denied';end if;
 if j.purpose='sales_email_link_v1' then
  select * into strict c from public.membership_v2_sales_email_challenges where source_id=s.id and source_fingerprint=s.source_fingerprint;
  select * into strict q from public.membership_v2_quote_drafts where id=s.quote_id and quote_digest=s.quote_digest and scope_id=s.scope_id
   and issuer_user_id=s.issuer_user_id and original_salesperson_user_id=s.issuer_user_id and audience='sales' and client_id is null and billing_owner_user_id is null;
  obsolete:=exists(select 1 from public.membership_v2_sales_email_proofs where source_id=s.id and token_hash=c.token_hash);
 else
  select * into strict d from public.membership_v2_issued_documents where id=j.document_id and source_id=s.id;
  select * into g from public.membership_v2_legal_gates where version=d.legal_version for share;
  if not found then raise exception 'delivery_claim_denied';end if;
  obsolete:=exists(select 1 from public.membership_v2_document_acceptances where document_id=d.id);
 end if;
 select * into k from public.membership_v2_delivery_keys where environment=j.environment and key_id=j.key_id for share;
 if not found or k.retired then raise exception 'delivery_claim_denied';end if;
 perform 1 from public.membership_v2_delivery_jobs where id=j.id for update;n:=clock_timestamp();
 if j.queued_at>n then raise exception 'delivery_claim_denied';end if;
 if obsolete then return 'skip_obsolete';end if;
 if(j.purpose='sales_email_link_v1' and(c.issued_at>n or c.expires_at<=n or q.issued_at>n or q.expires_at<=n))
  or(j.purpose='retail_signer_v2' and(g.revoked or d.issued_at>n or d.expires_at<=n)) then raise exception 'delivery_claim_denied';end if;
 return 'send';
end $$;
create function public.membership_v2_guard_delivery_attempt()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 new.disposition:=public.membership_v2_delivery_admission(new.job_id);new.claimed_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_delivery_attempt before insert on public.membership_v2_delivery_attempts
 for each row execute function public.membership_v2_guard_delivery_attempt();
create function public.membership_v2_claim_delivery(p_job uuid,p_attempt uuid)
returns setof public.membership_v2_delivery_attempts language plpgsql security invoker set search_path=pg_catalog as $$
begin
 -- Repeated SAME attempt gets no new claim. Unknown ACK uses readback only.
 return query insert into public.membership_v2_delivery_attempts(job_id,attempt_id)
  values(p_job,p_attempt) on conflict(job_id) do nothing returning *;
end $$;
create function public.membership_v2_before_delivery_send(p_job uuid,p_attempt uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if public.membership_v2_delivery_admission(p_job)<>'send' then return false;end if;
 return exists(select 1 from public.membership_v2_delivery_attempts where job_id=p_job and attempt_id=p_attempt and disposition='send')
  and not exists(select 1 from public.membership_v2_delivery_results where job_id=p_job);
end $$;
create function public.membership_v2_guard_delivery_result()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform 1 from public.membership_v2_delivery_jobs where id=new.job_id for update;
 if not exists(select 1 from public.membership_v2_delivery_attempts where job_id=new.job_id and attempt_id=new.attempt_id and disposition='send') then
  raise exception 'delivery_result_denied';end if;
 new.recorded_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_delivery_result before insert on public.membership_v2_delivery_results
 for each row execute function public.membership_v2_guard_delivery_result();
create function public.membership_v2_record_delivery_result(p_job uuid,p_attempt uuid,p_outcome text,p_reference text)
returns setof public.membership_v2_delivery_results language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.membership_v2_delivery_results;
begin
 perform 1 from public.membership_v2_delivery_jobs where id=p_job for update;
 select * into r from public.membership_v2_delivery_results where job_id=p_job;
 if found then
  if r.attempt_id=p_attempt and r.outcome=p_outcome and r.provider_reference is not distinct from p_reference then return next r;return;end if;
  raise exception 'delivery_result_conflict';
 end if;
 insert into public.membership_v2_delivery_results(job_id,attempt_id,outcome,provider_reference)
  values(p_job,p_attempt,p_outcome,p_reference) returning * into r;return next r;
end $$;
create function public.membership_v2_read_delivery_attempt(p_job uuid,p_attempt uuid)
returns table(job jsonb,attempt jsonb,result jsonb,key_identity jsonb)
language sql security invoker set search_path=pg_catalog as $$
 select to_jsonb(j),to_jsonb(a),to_jsonb(r),to_jsonb(k) from public.membership_v2_delivery_jobs j
  join public.membership_v2_delivery_attempts a on a.job_id=j.id and a.attempt_id=p_attempt
  join public.membership_v2_delivery_keys k on k.environment=j.environment and k.key_id=j.key_id
  left join public.membership_v2_delivery_results r on r.job_id=a.job_id and r.attempt_id=a.attempt_id where j.id=p_job;
$$;
-- Authenticated adapter supplies a verified actor; browser never gets envelope,
-- token hash/key identity/provider reference through this recovery projection.
create function public.membership_v2_delivery_status(p_actor uuid,p_scope uuid,p_job uuid)
returns table(job_id uuid,source_id uuid,document_id uuid,purpose text,environment text,state text,
 queued_at timestamptz,claimed_at timestamptz,recorded_at timestamptz)
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform 1 from public.sales_reps where user_id=p_actor and active for share;
 if not found or not exists(select 1 from public.membership_v2_sales_quote_scopes where id=p_scope and issuer_user_id=p_actor) then
  raise exception 'delivery_status_denied';end if;
 return query select j.id,j.source_id,j.document_id,j.purpose,j.environment,
  case when r.outcome is not null then r.outcome when a.disposition='skip_obsolete' then 'skipped_obsolete'
   when a.job_id is not null then 'held_unknown' else 'queued_unchecked' end,j.queued_at,a.claimed_at,r.recorded_at
  from public.membership_v2_delivery_jobs j left join public.membership_v2_delivery_attempts a on a.job_id=j.id
  left join public.membership_v2_delivery_results r on r.job_id=j.id
  where j.id=p_job and j.scope_id=p_scope and j.issuer_user_id=p_actor;
end $$;
do $$ declare t text;f record;begin
 foreach t in array array['membership_v2_delivery_keys','membership_v2_delivery_jobs','membership_v2_delivery_attempts','membership_v2_delivery_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on public.%I to service_role',t);
  if t<>'membership_v2_delivery_keys' then
   execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
   execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
  end if;
 end loop;
 -- Jobs UPDATE is ONLY for FOR UPDATE; immutable trigger rejects all updates.
 grant update on public.membership_v2_delivery_keys,public.membership_v2_delivery_jobs to service_role;
 for f in select oid::regprocedure as identity from pg_proc where pronamespace='public'::regnamespace
  and proname in ('membership_v2_guard_delivery_key','membership_v2_valid_delivery_envelope','membership_v2_guard_delivery_job',
   'membership_v2_register_source_and_delivery','membership_v2_issue_document_and_delivery','membership_v2_delivery_admission',
   'membership_v2_guard_delivery_attempt','membership_v2_claim_delivery','membership_v2_before_delivery_send',
   'membership_v2_guard_delivery_result','membership_v2_record_delivery_result','membership_v2_read_delivery_attempt','membership_v2_delivery_status') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.identity);
  execute format('grant execute on function %s to service_role',f.identity);
 end loop;
end $$;
commit;
