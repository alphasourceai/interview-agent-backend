-- LOCAL/unmounted. No legal publication is seeded, no bucket/route/identity or
-- contract is created. Only trusted backend publication/artifact inputs belong
-- here. This ledger is NOT proof a PDF exists or an unpaid access grant.
begin;

create function public.membership_v2_signing_deadline(p_issued timestamptz)
returns timestamptz language sql immutable strict security invoker set search_path=pg_catalog as $$
  select (date_trunc('day',p_issued at time zone 'America/Denver')+interval '1 day') at time zone 'America/Denver';
$$;

create table public.membership_v2_legal_versions (
  version text primary key check (version ~ '^retail-membership-issued-[A-Za-z0-9._-]{1,100}$' and version !~* 'draft|review'),
  template_sha256 text not null check (template_sha256 ~ '^[0-9a-f]{64}$'),
  refund_policy_version text not null check (char_length(refund_policy_version) between 1 and 120),
  refund_policy_reference text not null check (refund_policy_reference ~ '^https://[^[:space:]<>]+$' and char_length(refund_policy_reference)<=500),
  refund_policy_sha256 text not null check (refund_policy_sha256 ~ '^[0-9a-f]{64}$'),
  approval_reference text not null check (char_length(approval_reference) between 1 and 200 and approval_reference=btrim(approval_reference)),
  approved_at timestamptz not null default clock_timestamp() check (isfinite(approved_at))
);
create table public.membership_v2_legal_revocations (
  version text primary key references public.membership_v2_legal_versions(version) on delete restrict on update restrict,
  reason text not null check (char_length(reason) between 1 and 200),
  revoked_at timestamptz not null default clock_timestamp() check (isfinite(revoked_at))
);
-- Only mutable exception: a locked gate for each immutable published version.
-- It can transition false->true once, only with an existing revocation record.
create table public.membership_v2_legal_gates (
  version text primary key references public.membership_v2_legal_versions(version) on delete restrict on update restrict,
  revoked boolean not null default false
);
create table public.membership_v2_issued_documents (
  id uuid primary key check (id<>'00000000-0000-0000-0000-000000000000'::uuid),
  source_id uuid not null unique,
  source_fingerprint text not null,
  scope_id uuid not null references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
  issuer_user_id uuid not null references public.sales_reps(user_id) on delete restrict on update restrict,
  legal_version text not null references public.membership_v2_legal_versions(version) on delete restrict on update restrict,
  -- DERIVED by insert guard, not trusted as caller-provided frozen snapshots.
  source_snapshot jsonb not null,
  quote_snapshot jsonb not null,
  legal_snapshot jsonb not null,
  rendered_html text not null check (octet_length(rendered_html) between 1 and 2097152
    and rendered_html !~* 'review draft|not for signature|draft_only|retail-agreement-2026-10-11-draft-v1'),
  html_sha256 text not null check (html_sha256=encode(sha256(convert_to(rendered_html,'UTF8')),'hex')),
  preview_pdf_path text not null check (preview_pdf_path='retail-v2/'||id::text||'/preview.pdf'),
  preview_pdf_sha256 text not null check (preview_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  preview_pdf_size integer not null check (preview_pdf_size between 16 and 8388608),
  signer_token_hash text not null unique check (signer_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null check (isfinite(issued_at)),
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at=public.membership_v2_signing_deadline(issued_at) and expires_at>issued_at),
  unique(id,source_id),
  foreign key(source_id,source_fingerprint) references public.membership_v2_sales_prospects(id,source_fingerprint) on delete restrict on update restrict
);
create table public.membership_v2_document_acceptances (
  document_id uuid primary key,
  source_id uuid not null unique,
  scope_id uuid not null unique references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
  attempt_id uuid not null unique check (attempt_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  signer_token_hash text not null check (signer_token_hash ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  html_sha256 text not null check (html_sha256 ~ '^[0-9a-f]{64}$'),
  preview_pdf_sha256 text not null check (preview_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  consent boolean not null check (consent=true),
  typed_name text not null check (char_length(typed_name) between 1 and 160 and typed_name=btrim(typed_name)
    and typed_name !~ '[[:cntrl:]<>]' and typed_name !~ U&'[\061C\200E\200F\202A-\202E\2066-\2069]'),
  signature_path text not null check (signature_path='retail-v2/'||document_id::text||'/attempts/'||attempt_id::text||'/signature.png'),
  signature_sha256 text not null check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_size integer not null check (signature_size between 16 and 2097152),
  executed_pdf_path text not null check (executed_pdf_path='retail-v2/'||document_id::text||'/attempts/'||attempt_id::text||'/executed.pdf'),
  executed_pdf_sha256 text not null check (executed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  executed_pdf_size integer not null check (executed_pdf_size between 16 and 8388608),
  accepted_at timestamptz not null check (isfinite(accepted_at)),
  foreign key(document_id,source_id) references public.membership_v2_issued_documents(id,source_id) on delete restrict on update restrict
);

-- Native clock is sampled AFTER lock acquisition. Same order as source RPCs:
-- rep -> head -> immutable document read -> mutable legal gate lock. No parent
-- privilege is added. The locked gate reads the latest revocation state even
-- when the outer statement began before a concurrent revocation committed.
create function public.membership_v2_guard_issued_document()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.membership_v2_sales_prospects; q public.membership_v2_quote_drafts;
  l public.membership_v2_legal_versions; g public.membership_v2_legal_gates; n timestamptz;
begin
  perform 1 from public.sales_reps where user_id=new.issuer_user_id and active=true for share;
  if not found then raise exception 'issued_document_denied'; end if;
  select * into s from public.membership_v2_sales_prospects where id=new.source_id
    and scope_id=new.scope_id and issuer_user_id=new.issuer_user_id and source_fingerprint=new.source_fingerprint;
  if not found then raise exception 'issued_document_denied'; end if;
  perform 1 from public.membership_v2_sales_prospect_heads where scope_id=s.scope_id and current_source_id=s.id for update;
  if not found then raise exception 'issued_document_denied'; end if;
  select * into g from public.membership_v2_legal_gates where version=new.legal_version for update;
  if not found or g.revoked then raise exception 'issued_document_legal_unavailable'; end if;
  n:=clock_timestamp();
  select * into q from public.membership_v2_quote_drafts where id=s.quote_id and quote_digest=s.quote_digest
    and scope_id=s.scope_id and issuer_user_id=s.issuer_user_id and original_salesperson_user_id=s.issuer_user_id
    and audience='sales' and client_id is null and billing_owner_user_id is null and issued_at<=n and expires_at>n;
  if not found or not exists(select 1 from public.membership_v2_sales_email_proofs p
    join public.membership_v2_sales_email_challenges c on c.source_id=p.source_id and c.token_hash=p.token_hash
    where p.source_id=s.id and c.source_fingerprint=s.source_fingerprint and p.method='email_link_v1'
      and p.verified_at>=c.issued_at and p.verified_at<c.expires_at and p.verified_at<=n) then
    raise exception 'issued_document_denied'; end if;
  select * into l from public.membership_v2_legal_versions where version=new.legal_version and approved_at<=n;
  if not found or exists(select 1 from public.membership_v2_legal_revocations where version=l.version) then
    raise exception 'issued_document_legal_unavailable'; end if;
  new.source_snapshot:=s.canonical_source::jsonb;
  new.quote_snapshot:=q.canonical_quote::jsonb;
  new.legal_snapshot:=to_jsonb(l);
  new.html_sha256:=encode(sha256(convert_to(new.rendered_html,'UTF8')),'hex');
  new.issued_at:=n; new.expires_at:=public.membership_v2_signing_deadline(n);
  return new;
end $$;
create trigger membership_v2_guard_issued_document before insert on public.membership_v2_issued_documents
  for each row execute function public.membership_v2_guard_issued_document();

create function public.membership_v2_guard_document_acceptance()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare d public.membership_v2_issued_documents; g public.membership_v2_legal_gates; n timestamptz;
begin
  select * into d from public.membership_v2_issued_documents where id=new.document_id;
  if not found then raise exception 'document_acceptance_denied'; end if;
  perform 1 from public.sales_reps where user_id=d.issuer_user_id for share;
  if not found then raise exception 'document_acceptance_denied'; end if;
  perform 1 from public.membership_v2_sales_prospect_heads where scope_id=d.scope_id and current_source_id=d.source_id for update;
  if not found then raise exception 'document_acceptance_denied'; end if;
  -- Documents are immutable; head lock serializes all attempts for that source.
  -- No UPDATE privilege is granted merely to obtain an unnecessary document lock.
  select * into strict g from public.membership_v2_legal_gates where version=d.legal_version for update;
  n:=clock_timestamp();
  if d.source_id<>new.source_id or d.source_fingerprint<>new.source_fingerprint
    or d.html_sha256<>new.html_sha256 or d.preview_pdf_sha256<>new.preview_pdf_sha256
    or d.signer_token_hash<>new.signer_token_hash or d.issued_at>n or d.expires_at<=n
    or g.revoked then
    raise exception 'document_acceptance_denied'; end if;
  new.scope_id:=d.scope_id; new.accepted_at:=n;
  return new;
end $$;
create trigger membership_v2_guard_document_acceptance before insert on public.membership_v2_document_acceptances
  for each row execute function public.membership_v2_guard_document_acceptance();

create function public.membership_v2_guard_legal_version()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_when='BEFORE' then new.approved_at:=clock_timestamp(); return new; end if;
  insert into public.membership_v2_legal_gates(version) values(new.version); return new;
end $$;
create trigger membership_v2_guard_legal_version before insert on public.membership_v2_legal_versions
  for each row execute function public.membership_v2_guard_legal_version();
create trigger membership_v2_create_legal_gate after insert on public.membership_v2_legal_versions
  for each row execute function public.membership_v2_guard_legal_version();
create function public.membership_v2_guard_legal_gate()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_op='INSERT' then
    if new.revoked then raise exception 'invalid_legal_gate'; end if;
  elsif new.version is distinct from old.version or old.revoked or not new.revoked
    or not exists(select 1 from public.membership_v2_legal_revocations where version=new.version) then
    raise exception 'invalid_legal_gate_transition';
  end if;
  return new;
end $$;
create trigger membership_v2_guard_legal_gate before insert or update on public.membership_v2_legal_gates
  for each row execute function public.membership_v2_guard_legal_gate();
create function public.membership_v2_guard_legal_revocation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_when='BEFORE' then
    perform 1 from public.membership_v2_legal_gates where version=new.version for update;
    if not found then raise exception 'legal_revocation_denied'; end if;
    new.revoked_at:=clock_timestamp(); return new;
  end if;
  update public.membership_v2_legal_gates set revoked=true where version=new.version;
  return new;
end $$;
create trigger membership_v2_guard_legal_revocation before insert on public.membership_v2_legal_revocations
  for each row execute function public.membership_v2_guard_legal_revocation();
create trigger membership_v2_apply_legal_revocation after insert on public.membership_v2_legal_revocations
  for each row execute function public.membership_v2_guard_legal_revocation();
create function public.membership_v2_guard_accepted_sales_head()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if exists(select 1 from public.membership_v2_document_acceptances where scope_id=old.scope_id) then
    raise exception 'accepted_sales_source_immutable'; end if;
  return new;
end $$;
create trigger membership_v2_guard_accepted_sales_head before update on public.membership_v2_sales_prospect_heads
  for each row execute function public.membership_v2_guard_accepted_sales_head();

-- Service-only RPC, argument row is a trusted prepared-artifact descriptor,
-- never raw req.body. Stored snapshots/times are overwritten by native guard.
create function public.membership_v2_issue_document(p_document jsonb)
returns setof public.membership_v2_issued_documents
language plpgsql security invoker set search_path=pg_catalog as $$
declare d public.membership_v2_issued_documents;
begin
  if jsonb_typeof(p_document) is distinct from 'object' then raise exception 'issued_document_denied'; end if;
  if (select count(*) from jsonb_object_keys(p_document))<>12 or not (p_document ?& array[
    'id','source_id','source_fingerprint','scope_id','issuer_user_id','legal_version','rendered_html','html_sha256',
    'preview_pdf_path','preview_pdf_sha256','preview_pdf_size','signer_token_hash']) then raise exception 'issued_document_denied'; end if;
  insert into public.membership_v2_issued_documents(id,source_id,source_fingerprint,scope_id,issuer_user_id,legal_version,
    rendered_html,html_sha256,preview_pdf_path,preview_pdf_sha256,preview_pdf_size,signer_token_hash)
    values((p_document->>'id')::uuid,(p_document->>'source_id')::uuid,p_document->>'source_fingerprint',
      (p_document->>'scope_id')::uuid,(p_document->>'issuer_user_id')::uuid,p_document->>'legal_version',
      p_document->>'rendered_html',p_document->>'html_sha256',p_document->>'preview_pdf_path',
      p_document->>'preview_pdf_sha256',(p_document->>'preview_pdf_size')::integer,p_document->>'signer_token_hash')
    returning * into d;
  return next d;
end $$;

-- No blind retries: same document/attempt and complete evidence equality only.
-- A different signature attempt cannot overwrite the first acceptance.
create function public.membership_v2_accept_document(p_acceptance jsonb)
returns setof public.membership_v2_document_acceptances
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_v2_document_acceptances; d public.membership_v2_issued_documents;
begin
  if jsonb_typeof(p_acceptance) is distinct from 'object' then raise exception 'document_acceptance_denied'; end if;
  if (select count(*) from jsonb_object_keys(p_acceptance))<>15 or not (p_acceptance ?& array[
    'document_id','source_id','attempt_id','signer_token_hash','source_fingerprint','html_sha256','preview_pdf_sha256',
    'consent','typed_name','signature_path','signature_sha256','signature_size','executed_pdf_path','executed_pdf_sha256','executed_pdf_size'])
    or p_acceptance->'consent' is distinct from 'true'::jsonb then raise exception 'document_acceptance_denied'; end if;
  select * into d from public.membership_v2_issued_documents where id=(p_acceptance->>'document_id')::uuid;
  if not found then raise exception 'document_acceptance_denied'; end if;
  perform 1 from public.sales_reps where user_id=d.issuer_user_id for share;
  if not found then raise exception 'document_acceptance_denied'; end if;
  perform 1 from public.membership_v2_sales_prospect_heads where scope_id=d.scope_id and current_source_id=d.source_id for update;
  if not found then raise exception 'document_acceptance_denied'; end if;
  select * into a from public.membership_v2_document_acceptances where document_id=d.id;
  if found then
    if (to_jsonb(a)-'accepted_at'-'scope_id')=p_acceptance then return next a; return; end if;
    raise exception 'document_acceptance_conflict';
  end if;
  insert into public.membership_v2_document_acceptances(document_id,source_id,attempt_id,signer_token_hash,source_fingerprint,
    html_sha256,preview_pdf_sha256,consent,typed_name,signature_path,signature_sha256,signature_size,
    executed_pdf_path,executed_pdf_sha256,executed_pdf_size)
    values(d.id,(p_acceptance->>'source_id')::uuid,(p_acceptance->>'attempt_id')::uuid,p_acceptance->>'signer_token_hash',
      p_acceptance->>'source_fingerprint',p_acceptance->>'html_sha256',p_acceptance->>'preview_pdf_sha256',
      (p_acceptance->>'consent')::boolean,p_acceptance->>'typed_name',p_acceptance->>'signature_path',
      p_acceptance->>'signature_sha256',(p_acceptance->>'signature_size')::integer,p_acceptance->>'executed_pdf_path',
      p_acceptance->>'executed_pdf_sha256',(p_acceptance->>'executed_pdf_size')::integer) returning * into a;
  return next a;
end $$;

do $$ declare t text; begin
  foreach t in array array['membership_v2_legal_versions','membership_v2_legal_revocations','membership_v2_issued_documents','membership_v2_document_acceptances'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert on public.%I to service_role',t);
  end loop;
end $$;
alter table public.membership_v2_legal_gates enable row level security;
revoke all on public.membership_v2_legal_gates from public,anon,authenticated,service_role;
grant select,insert,update on public.membership_v2_legal_gates to service_role;
create trigger membership_v2_legal_gates_no_delete before delete on public.membership_v2_legal_gates
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_legal_gates_no_truncate before truncate on public.membership_v2_legal_gates
  for each statement execute function public.membership_v2_reject_mutation();
revoke all on function public.membership_v2_signing_deadline(timestamptz),public.membership_v2_guard_issued_document(),
  public.membership_v2_guard_document_acceptance(),public.membership_v2_guard_legal_revocation(),public.membership_v2_guard_accepted_sales_head(),
  public.membership_v2_guard_legal_version(),public.membership_v2_guard_legal_gate(),
  public.membership_v2_issue_document(jsonb),public.membership_v2_accept_document(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_signing_deadline(timestamptz),public.membership_v2_guard_issued_document(),
  public.membership_v2_guard_document_acceptance(),public.membership_v2_guard_legal_revocation(),public.membership_v2_guard_accepted_sales_head(),
  public.membership_v2_guard_legal_version(),public.membership_v2_guard_legal_gate(),
  public.membership_v2_issue_document(jsonb),public.membership_v2_accept_document(jsonb) to service_role;
commit;
