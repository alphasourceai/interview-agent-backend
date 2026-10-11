-- Prospective quote drafts, not signatures/acceptances or paid contracts. No
-- source, client, Auth, activation, provider, delivery or legacy-data mutation.
begin;

-- Same fixed-key, compact, explicit-null encoding as the server. CHECKs below
-- validate these exact bytes against the complete column-derived document.
-- pg_catalog.sha256 is built into the supported PG17 baseline; no extension.
create function public.membership_v2_quote_canonical(p_value jsonb)
returns text language plpgsql immutable strict security invoker
set search_path = pg_catalog, public as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || public.membership_v2_quote_canonical(value),
        ',' order by key collate "C"),'') || '}' into v_result from jsonb_each(p_value);
    when 'array' then
      select '[' || coalesce(string_agg(public.membership_v2_quote_canonical(value),',' order by ord),'') || ']'
        into v_result from jsonb_array_elements(p_value) with ordinality as x(value,ord);
    else v_result := p_value::text;
  end case;
  return v_result;
end $$;

create table public.membership_v2_quote_drafts (
  id uuid primary key,
  scope_id uuid not null,
  audience text not null check (audience in ('public','sales','admin')),
  issuer_user_id uuid references auth.users(id) on delete restrict on update restrict,
  original_salesperson_user_id uuid references auth.users(id) on delete restrict on update restrict,
  client_id uuid references public.clients(id) on delete restrict on update restrict,
  billing_owner_user_id uuid references auth.users(id) on delete restrict on update restrict,
  offer_snapshot jsonb not null check (public.membership_v2_valid_offer(offer_snapshot)),
  template_version text not null check (template_version = 'retail-agreement-2026-10-11-draft-v1'),
  template_status text not null check (template_status = 'draft_only'),
  issued_at timestamptz not null check (isfinite(issued_at)),
  expires_at timestamptz not null check (isfinite(expires_at)),
  canonical_quote text not null check (octet_length(canonical_quote) between 1 and 16000),
  quote_digest text not null check (quote_digest ~ '^[0-9a-f]{64}$'),
  check (id <> '00000000-0000-0000-0000-000000000000'::uuid
    and scope_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  check (num_nonnulls(client_id,billing_owner_user_id) in (0,2)),
  check ((audience = 'public' and issuer_user_id is null and original_salesperson_user_id is null and client_id is null)
    or (audience = 'sales' and issuer_user_id is not null and original_salesperson_user_id is not null
      and issuer_user_id = original_salesperson_user_id)
    or (audience = 'admin' and issuer_user_id is not null)),
  check (audience <> 'public' or offer_snapshot->>'payment_option' = 'prepaid'),
  check (expires_at = issued_at + interval '30 minutes'
    and date_trunc('milliseconds',issued_at) = issued_at
    and extract(year from issued_at at time zone 'UTC') between 1 and 9999
    and extract(year from expires_at at time zone 'UTC') between 1 and 9999),
  check (canonical_quote::jsonb = jsonb_build_object(
    'schema_version',2,'protocol','retail_quote_draft_v2','acceptance_state','unsigned','signing_source_bound',false,
    'quote_id',id,'scope_id',scope_id,
    'audience',audience,'issuer_user_id',issuer_user_id,'original_salesperson_user_id',original_salesperson_user_id,
    'client_id',client_id,'billing_owner_user_id',billing_owner_user_id,'offer',offer_snapshot,
    'template_version',template_version,'template_status',template_status,
    'issued_at',to_char(issued_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expires_at',to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
  check (canonical_quote = public.membership_v2_quote_canonical(canonical_quote::jsonb)),
  check (quote_digest = encode(pg_catalog.sha256(convert_to(canonical_quote,'UTF8')),'hex'))
);
create index membership_v2_quote_drafts_scope_idx on public.membership_v2_quote_drafts(scope_id,id);
create trigger membership_v2_quote_drafts_immutable before update or delete on public.membership_v2_quote_drafts
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_quote_drafts_no_truncate before truncate on public.membership_v2_quote_drafts
  for each statement execute function public.membership_v2_reject_mutation();
alter table public.membership_v2_quote_drafts enable row level security;
revoke all on public.membership_v2_quote_drafts from public,anon,authenticated,service_role;
grant select,insert on public.membership_v2_quote_drafts to service_role;
revoke all on function public.membership_v2_quote_canonical(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_quote_canonical(jsonb) to service_role;
-- The inherited validator/immutability functions are SECURITY INVOKER, with
-- PUBLIC/browser execute revoked in the earlier contract-store migration.
commit;
