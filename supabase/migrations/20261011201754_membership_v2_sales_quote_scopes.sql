-- Inert, manual sales-only prospect scopes. NOT buyer verification, agreement
-- acceptance or authorization to activate/pay. No legacy/source writes.
begin;
create table public.membership_v2_sales_quote_scopes (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  issuer_user_id uuid not null references public.sales_reps(user_id) on delete restrict on update restrict,
  audience text not null default 'sales' check (audience = 'sales'),
  scope_kind text not null default 'manual_prospect' check (scope_kind = 'manual_prospect'),
  source_verified boolean not null default false check (source_verified = false),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now() check (isfinite(created_at)),
  constraint membership_v2_sales_scopes_actor_key_unique unique (issuer_user_id,idempotency_key_hash),
  check (id <> '00000000-0000-0000-0000-000000000000'::uuid
    and issuer_user_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  check (request_fingerprint = encode(pg_catalog.sha256(convert_to(
    'manual-prospect-scope-v1' || chr(10) || issuer_user_id::text || chr(10)
      || audience || chr(10) || scope_kind, 'UTF8')),'hex'))
);
create trigger membership_v2_sales_scopes_immutable before update or delete on public.membership_v2_sales_quote_scopes
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_sales_scopes_no_truncate before truncate on public.membership_v2_sales_quote_scopes
  for each statement execute function public.membership_v2_reject_mutation();
alter table public.membership_v2_sales_quote_scopes enable row level security;
revoke all on public.membership_v2_sales_quote_scopes from public,anon,authenticated,service_role;
grant select,insert on public.membership_v2_sales_quote_scopes to service_role;

-- Caller is the trusted backend, not a browser/JWT claim. The backend verifies
-- Auth identity before and after the RPC. Existing sales_reps SELECT+UPDATE
-- grants permit FOR SHARE; this migration grants nothing new on parent tables.
create function public.membership_v2_reserve_sales_quote_scope(
  p_actor uuid,p_key_hash text,p_fingerprint text)
returns setof public.membership_v2_sales_quote_scopes
language plpgsql security invoker set search_path = pg_catalog as $$
declare v_scope public.membership_v2_sales_quote_scopes;
begin
  if p_actor is null or p_actor = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_key_hash ~ '^[0-9a-f]{64}$') is not true
    or (p_fingerprint ~ '^[0-9a-f]{64}$') is not true then
    raise exception 'invalid_sales_scope_request';
  end if;
  perform 1 from public.sales_reps where user_id = p_actor and active = true for share;
  if not found then raise exception 'sales_scope_denied'; end if;
  if p_fingerprint <> encode(pg_catalog.sha256(convert_to('manual-prospect-scope-v1'
    || chr(10) || p_actor::text || chr(10) || 'sales' || chr(10) || 'manual_prospect','UTF8')),'hex') then
    raise exception 'sales_scope_conflict';
  end if;
  insert into public.membership_v2_sales_quote_scopes(issuer_user_id,idempotency_key_hash,request_fingerprint)
    values(p_actor,p_key_hash,p_fingerprint) on conflict(issuer_user_id,idempotency_key_hash) do nothing;
  select * into strict v_scope from public.membership_v2_sales_quote_scopes
    where issuer_user_id = p_actor and idempotency_key_hash = p_key_hash;
  if v_scope.request_fingerprint <> p_fingerprint then raise exception 'sales_scope_conflict'; end if;
  return next v_scope;
end $$;
revoke all on function public.membership_v2_reserve_sales_quote_scope(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_reserve_sales_quote_scope(uuid,text,text) to service_role;
commit;
