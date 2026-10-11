-- LOCAL/unmounted manual sales sources. Email proof is NOT an acceptance,
-- buyer Auth identity, client access grant or authority to charge/activate.
begin;
create function public.membership_v2_valid_buyer(p_buyer jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text; v text; limits jsonb := '{"company_legal_name":160,"company_dba":160,"buyer_first_name":80,"buyer_last_name":80,"buyer_email":254,"buyer_phone":16,"buyer_title":120}'::jsonb;
begin
  if jsonb_typeof(p_buyer) <> 'object' or p_buyer is null
    or (select count(*) from jsonb_object_keys(p_buyer)) <> 7 then return false; end if;
  for k in select jsonb_object_keys(limits) loop
    if not (p_buyer ? k) then return false; end if;
    if p_buyer->k = 'null'::jsonb and k in ('company_dba','buyer_phone','buyer_title') then continue; end if;
    if jsonb_typeof(p_buyer->k) <> 'string' then return false; end if;
    v := p_buyer->>k;
    if char_length(v) not between 1 and (limits->>k)::integer or v <> btrim(v)
      or v ~ '[[:cntrl:]<>]' then return false; end if;
  end loop;
  return coalesce(p_buyer->>'buyer_email' = lower(p_buyer->>'buyer_email')
    and p_buyer->>'buyer_email' ~ '^[a-z0-9][a-z0-9.!#$%&''*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    and p_buyer->>'buyer_email' !~ '\.\.|\.@'
    and ((p_buyer->'buyer_phone') = 'null'::jsonb or p_buyer->>'buyer_phone' ~ '^\+[1-9][0-9]{7,14}$'),false);
end $$;

create table public.membership_v2_sales_prospects (
  id uuid primary key check (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  scope_id uuid not null references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
  issuer_user_id uuid not null references public.sales_reps(user_id) on delete restrict on update restrict,
  quote_id uuid not null unique references public.membership_v2_quote_drafts(id) on delete restrict on update restrict,
  quote_digest text not null check (quote_digest ~ '^[0-9a-f]{64}$'),
  previous_source_id uuid,
  protocol text not null default 'retail_sales_prospect_v2' check (protocol='retail_sales_prospect_v2'),
  source_version integer not null default 1 check (source_version=1),
  buyer_snapshot jsonb not null check (public.membership_v2_valid_buyer(buyer_snapshot)),
  canonical_source text not null check (octet_length(canonical_source) between 1 and 8000),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp() check (isfinite(created_at)),
  unique(id,scope_id), unique(id,source_fingerprint),
  foreign key(previous_source_id,scope_id) references public.membership_v2_sales_prospects(id,scope_id) on delete restrict on update restrict,
  check (id is distinct from previous_source_id),
  check (canonical_source::jsonb = jsonb_build_object('protocol',protocol,'source_version',source_version,
    'source_id',id,'scope_id',scope_id,'issuer_user_id',issuer_user_id,'original_salesperson_user_id',issuer_user_id,
    'quote_id',quote_id,'quote_digest',quote_digest,'previous_source_id',previous_source_id,
    'buyer',buyer_snapshot,'acceptance_state','unsigned')),
  check (canonical_source=public.membership_v2_quote_canonical(canonical_source::jsonb)),
  check (source_fingerprint=encode(pg_catalog.sha256(convert_to(canonical_source,'UTF8')),'hex'))
);
create table public.membership_v2_sales_prospect_heads (
  scope_id uuid primary key references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
  current_source_id uuid,
  foreign key(current_source_id,scope_id) references public.membership_v2_sales_prospects(id,scope_id) on delete restrict on update restrict
);
create table public.membership_v2_sales_email_challenges (
  source_id uuid primary key,
  source_fingerprint text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  method text not null default 'email_link_v1' check (method='email_link_v1'),
  issued_at timestamptz not null check (isfinite(issued_at)),
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at>issued_at and expires_at<=issued_at+interval '10 minutes'),
  unique(source_id,token_hash),
  foreign key(source_id,source_fingerprint) references public.membership_v2_sales_prospects(id,source_fingerprint) on delete restrict on update restrict
);
create table public.membership_v2_sales_email_proofs (
  source_id uuid primary key,
  token_hash text not null,
  verified_at timestamptz not null check (isfinite(verified_at)),
  method text not null default 'email_link_v1' check (method='email_link_v1'),
  foreign key(source_id,token_hash) references public.membership_v2_sales_email_challenges(source_id,token_hash) on delete restrict on update restrict
);

create function public.membership_v2_sales_head_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.scope_id is distinct from old.scope_id or new.current_source_id is null
    or not exists(select 1 from public.membership_v2_sales_prospects
      where id=new.current_source_id and scope_id=new.scope_id and previous_source_id is not distinct from old.current_source_id)
    then raise exception 'invalid_sales_source_transition'; end if;
  return new;
end $$;
create trigger membership_v2_sales_head_guard before update on public.membership_v2_sales_prospect_heads
  for each row execute function public.membership_v2_sales_head_guard();
create trigger membership_v2_sales_head_no_delete before delete on public.membership_v2_sales_prospect_heads
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_sales_head_no_truncate before truncate on public.membership_v2_sales_prospect_heads
  for each statement execute function public.membership_v2_reject_mutation();
do $$ declare t text; begin
  foreach t in array array['membership_v2_sales_prospects','membership_v2_sales_email_challenges','membership_v2_sales_email_proofs'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
  end loop;
  foreach t in array array['membership_v2_sales_prospects','membership_v2_sales_prospect_heads','membership_v2_sales_email_challenges','membership_v2_sales_email_proofs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert on public.%I to service_role',t);
  end loop;
end $$;
grant update on public.membership_v2_sales_prospect_heads to service_role;

create function public.membership_v2_register_sales_prospect(p_id uuid,p_actor uuid,p_scope uuid,p_quote uuid,
  p_quote_digest text,p_previous uuid,p_buyer jsonb,p_canonical text,p_fingerprint text,p_token_hash text)
returns setof public.membership_v2_sales_prospects
language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.membership_v2_sales_prospects; q public.membership_v2_quote_drafts;
  h public.membership_v2_sales_prospect_heads; n timestamptz;
begin
  perform 1 from public.sales_reps where user_id=p_actor and active=true for share;
  if not found or not exists(select 1 from public.membership_v2_sales_quote_scopes
    where id=p_scope and issuer_user_id=p_actor and audience='sales' and scope_kind='manual_prospect') then
    raise exception 'sales_source_denied'; end if;
  insert into public.membership_v2_sales_prospect_heads(scope_id) values(p_scope) on conflict do nothing;
  select * into strict h from public.membership_v2_sales_prospect_heads where scope_id=p_scope for update;
  n := clock_timestamp();
  select * into q from public.membership_v2_quote_drafts where id=p_quote and scope_id=p_scope
    and audience='sales' and issuer_user_id=p_actor and original_salesperson_user_id=p_actor
    and client_id is null and billing_owner_user_id is null and quote_digest=p_quote_digest;
  if not found or q.issued_at>n or q.expires_at<=n then raise exception 'sales_source_denied'; end if;
  select * into s from public.membership_v2_sales_prospects where id=p_id;
  if found then
    if h.current_source_id=p_id and s.scope_id=p_scope and s.issuer_user_id=p_actor and s.quote_id=p_quote
      and s.quote_digest=p_quote_digest and s.previous_source_id is not distinct from p_previous
      and s.buyer_snapshot=p_buyer and s.canonical_source=p_canonical and s.source_fingerprint=p_fingerprint
      and exists(select 1 from public.membership_v2_sales_email_challenges where source_id=p_id and token_hash=p_token_hash)
      then return next s; return; end if;
    raise exception 'sales_source_conflict';
  end if;
  if h.current_source_id is distinct from p_previous then raise exception 'sales_source_conflict'; end if;
  insert into public.membership_v2_sales_prospects(id,scope_id,issuer_user_id,quote_id,quote_digest,previous_source_id,
    buyer_snapshot,canonical_source,source_fingerprint,created_at)
    values(p_id,p_scope,p_actor,p_quote,p_quote_digest,p_previous,p_buyer,p_canonical,p_fingerprint,n) returning * into s;
  insert into public.membership_v2_sales_email_challenges(source_id,source_fingerprint,token_hash,issued_at,expires_at)
    values(p_id,p_fingerprint,p_token_hash,n,least(n+interval '10 minutes',q.expires_at));
  update public.membership_v2_sales_prospect_heads set current_source_id=p_id where scope_id=p_scope;
  return next s;
end $$;

create function public.membership_v2_verify_sales_email(p_source uuid,p_token_hash text)
returns setof public.membership_v2_sales_email_proofs
language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.membership_v2_sales_prospects; c public.membership_v2_sales_email_challenges;
  h public.membership_v2_sales_prospect_heads; proof public.membership_v2_sales_email_proofs; n timestamptz;
begin
  select * into s from public.membership_v2_sales_prospects where id=p_source;
  if not found then raise exception 'sales_email_denied'; end if;
  perform 1 from public.sales_reps where user_id=s.issuer_user_id and active=true for share;
  if not found then raise exception 'sales_email_denied'; end if;
  select * into h from public.membership_v2_sales_prospect_heads where scope_id=s.scope_id for update;
  n := clock_timestamp();
  select * into c from public.membership_v2_sales_email_challenges where source_id=p_source and token_hash=p_token_hash;
  if h.current_source_id is distinct from p_source or c.source_id is null or c.source_fingerprint<>s.source_fingerprint
    or c.issued_at>n or c.expires_at<=n or not exists(select 1 from public.membership_v2_quote_drafts
      where id=s.quote_id and quote_digest=s.quote_digest and issued_at<=n and expires_at>n) then
    raise exception 'sales_email_denied'; end if;
  insert into public.membership_v2_sales_email_proofs(source_id,token_hash,verified_at)
    values(p_source,p_token_hash,n) on conflict(source_id) do nothing;
  select * into strict proof from public.membership_v2_sales_email_proofs where source_id=p_source and token_hash=p_token_hash;
  return next proof;
end $$;
-- Authoritative clock + actor-scoped recovery, including expired unsigned heads.
-- Read locks follow rep->head, never change a row and never enable signing.
create function public.membership_v2_read_sales_prospect(p_actor uuid,p_scope uuid,p_source uuid)
returns table(scope_id uuid,current_source_id uuid,quote_live boolean,challenge_live boolean,proof_valid boolean,observed_at timestamptz)
language plpgsql security invoker set search_path=pg_catalog as $$
declare h public.membership_v2_sales_prospect_heads; s public.membership_v2_sales_prospects;
  q public.membership_v2_quote_drafts; c public.membership_v2_sales_email_challenges;
  p public.membership_v2_sales_email_proofs; n timestamptz;
begin
  perform 1 from public.sales_reps r where r.user_id=p_actor and r.active=true for share;
  if not found or not exists(select 1 from public.membership_v2_sales_quote_scopes ss
    where ss.id=p_scope and ss.issuer_user_id=p_actor) then raise exception 'sales_source_denied'; end if;
  select * into h from public.membership_v2_sales_prospect_heads hh where hh.scope_id=p_scope for share;
  n := clock_timestamp();
  if p_source is not null and h.current_source_id is distinct from p_source then raise exception 'sales_source_denied'; end if;
  if h.current_source_id is null then return query select p_scope,null::uuid,false,false,false,n; return; end if;
  select * into strict s from public.membership_v2_sales_prospects ss where ss.id=h.current_source_id
    and ss.scope_id=p_scope and ss.issuer_user_id=p_actor and ss.created_at<=n;
  select * into strict q from public.membership_v2_quote_drafts qq where qq.id=s.quote_id and qq.quote_digest=s.quote_digest
    and qq.scope_id=p_scope and qq.issuer_user_id=p_actor and qq.original_salesperson_user_id=p_actor
    and qq.audience='sales' and qq.client_id is null and qq.billing_owner_user_id is null;
  select * into c from public.membership_v2_sales_email_challenges cc where cc.source_id=s.id and cc.source_fingerprint=s.source_fingerprint;
  select * into p from public.membership_v2_sales_email_proofs pp where pp.source_id=s.id and pp.token_hash=c.token_hash;
  return query select p_scope,s.id,q.issued_at<=n and n<q.expires_at,
    coalesce(c.issued_at<=n and n<c.expires_at,false),
    coalesce(p.verified_at>=c.issued_at and p.verified_at<c.expires_at and p.verified_at<=n,false),n;
end $$;
revoke all on function public.membership_v2_valid_buyer(jsonb),public.membership_v2_sales_head_guard(),
  public.membership_v2_register_sales_prospect(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,text,text),
  public.membership_v2_verify_sales_email(uuid,text),public.membership_v2_read_sales_prospect(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_valid_buyer(jsonb),public.membership_v2_sales_head_guard(),
  public.membership_v2_register_sales_prospect(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,text,text),
  public.membership_v2_verify_sales_email(uuid,text),public.membership_v2_read_sales_prospect(uuid,uuid,uuid) to service_role;
commit;
