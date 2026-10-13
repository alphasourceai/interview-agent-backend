-- Local pricing slice only. No receipt admission, Auth, account, payment or ACH
-- flow. Freeze the original sales qualification inside EXISTING completion.
begin;
set local lock_timeout='10s';
do $guard$
begin
  if to_regclass('public.retail_existing_sales_qualifications') is not null
    or to_regprocedure('public.retail_existing_sales_terms_digest(jsonb)') is not null
    or to_regprocedure('public.retail_existing_sales_qualification_guard()') is not null
  then raise exception 'retail_sales_qualification_schema_drift'; end if;
  -- Never infer qualifications for already-completed prospective sales.
  if exists(select 1 from public.public_purchase_intents where channel='sales_assisted'
    and activated_at is not null and package_snapshot ?| array['pricing_protocol','membership_terms','pricing_version'])
  then raise exception 'retail_sales_qualification_existing_cohort_review_required'; end if;
end $guard$;

create function public.retail_existing_sales_terms_digest(p_terms jsonb)
returns text language plpgsql stable strict security invoker set search_path=pg_catalog as $$
declare ext_schema text; result text;
begin
  if not public.retail_existing_valid_offer(p_terms) then
    raise exception 'retail_sales_qualification_offer_invalid'; end if;
  select n.nspname into strict ext_schema from pg_extension e
    join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select encode(%I.digest(convert_to($1,''UTF8''),''sha256''),''hex'')',ext_schema)
    into result using p_terms::text;
  return result;
end $$;

create table public.retail_existing_sales_qualifications (
  purchase_intent_id uuid primary key references public.public_purchase_intents(id) on delete restrict,
  agreement_id uuid not null unique references public.membership_agreements(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  rep_user_id uuid not null references public.sales_reps(user_id) on delete restrict,
  terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  platform_cap_cents bigint not null check(platform_cap_cents > 0 and platform_cap_cents <= 9007199254740991),
  payment_kind text not null check(payment_kind in('monthly','paid_in_full')),
  original_start_at timestamptz not null check(isfinite(original_start_at)),
  original_term_end_at timestamptz not null check(isfinite(original_term_end_at)),
  commission_window_end_at timestamptz not null check(isfinite(commission_window_end_at)),
  qualification_closed_at timestamptz not null check(qualification_closed_at=original_start_at),
  check(original_term_end_at > original_start_at and commission_window_end_at >= original_term_end_at),
  unique(purchase_intent_id,agreement_id,client_id,rep_user_id)
);
create index retail_existing_sales_qualification_client_idx on public.retail_existing_sales_qualifications(client_id);
create index retail_existing_sales_qualification_rep_idx on public.retail_existing_sales_qualifications(rep_user_id);
alter table public.retail_existing_sales_qualifications enable row level security;
revoke all on public.retail_existing_sales_qualifications from public,anon,authenticated,service_role;
grant select,insert on public.retail_existing_sales_qualifications to service_role;

create function public.retail_existing_sales_qualification_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare i public.public_purchase_intents; a public.membership_agreements; months integer; offer jsonb; client_id uuid;
begin
  if TG_OP <> 'INSERT' then raise exception 'retail_sales_qualification_immutable'; end if;
  -- Same lock order as completion. Direct privileged insert must correspond to
  -- the exact completed source too, not a browser-supplied timestamp/creator.
  select * into i from public.public_purchase_intents where id=new.purchase_intent_id for update;
  select * into a from public.membership_agreements where id=new.agreement_id for update;
  select id into client_id from public.clients where id=new.client_id for update;
  months:=public.retail_existing_terms_months(to_jsonb(a),to_jsonb(i));
  offer:=i.package_snapshot->'membership_terms';
  if months <= 0 or i.id is null or a.id is null or client_id is null
    or i.channel is distinct from 'sales_assisted' or i.status is distinct from 'completed'
    or a.template_snapshot->>'source' is distinct from 'sales_assisted'
    or a.status is distinct from 'signed' or a.checkout_status is distinct from 'paid'
    or a.is_current is distinct from true or a.superseded_by_agreement_id is not null
    or i.agreement_id is distinct from a.id or i.client_id is distinct from new.client_id
    or a.client_id is distinct from new.client_id or i.created_by_user_id is distinct from new.rep_user_id
    or i.activated_at is distinct from a.checkout_paid_at or i.activated_at is distinct from new.original_start_at
    or new.qualification_closed_at is distinct from new.original_start_at
    or a.signed_at is null or new.original_start_at < a.signed_at
    or new.original_term_end_at is distinct from public.retail_existing_month_anchor(new.original_start_at,months)
    or new.commission_window_end_at is distinct from public.retail_existing_month_anchor(new.original_start_at,12)
    or new.terms_digest is distinct from public.retail_existing_sales_terms_digest(offer)
    or new.platform_cap_cents is distinct from (offer->>'platform_payment_cents')::bigint
    or new.payment_kind is distinct from(case when offer->>'payment_option'='prepaid' then 'paid_in_full' else 'monthly' end)
  then raise exception 'retail_sales_qualification_source_mismatch'; end if;
  return new;
end $$;
create trigger retail_existing_sales_qualification_source before insert or update or delete
  on public.retail_existing_sales_qualifications for each row execute function public.retail_existing_sales_qualification_guard();
create trigger retail_existing_sales_qualification_no_truncate before truncate
  on public.retail_existing_sales_qualifications for each statement execute function public.retail_existing_sales_qualification_guard();
revoke all on function public.retail_existing_sales_terms_digest(jsonb),public.retail_existing_sales_qualification_guard()
  from public,anon,authenticated;
grant execute on function public.retail_existing_sales_terms_digest(jsonb),public.retail_existing_sales_qualification_guard() to service_role;

do $patch$
declare
  sig text:='public.complete_public_purchase_activation(uuid,text,timestamp with time zone,text,uuid,boolean,text,text,date,date)';
  proc_oid oid; definition text; original_acl aclitem[]; original_owner oid; original_config text[];
  declaration text:='  v_retail_anchor timestamptz;';
  marker text:='  return jsonb_build_object(''status'', ''completed'', ''client_id'', v_client_id,';
  addition text;
begin
  proc_oid:=to_regprocedure(sig);
  select pg_get_functiondef(p.oid),p.proacl,p.proowner,p.proconfig
    into definition,original_acl,original_owner,original_config from pg_proc p where p.oid=proc_oid;
  if definition is null or not(select p.prosecdef from pg_proc p where p.oid=proc_oid)
    or original_config is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon',proc_oid,'EXECUTE') or has_function_privilege('authenticated',proc_oid,'EXECUTE')
    or not has_function_privilege('service_role',proc_oid,'EXECUTE')
    or strpos(definition,'select * into v_intent from public.public_purchase_intents')=0
    or strpos(definition,'select * into v_agreement from public.membership_agreements')
      <=strpos(definition,'select * into v_intent from public.public_purchase_intents')
    or strpos(definition,'where id = v_client_id for update;')=0
    or strpos(definition,'v_retail_months := public.retail_existing_terms_months(to_jsonb(v_agreement),to_jsonb(v_intent));')=0
    or strpos(definition,'activated_at = coalesce(activated_at, v_agreement.checkout_paid_at, p_paid_at),')=0
    or (length(definition)-length(replace(definition,declaration,'')))/length(declaration)<>1
    or (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1
  then raise exception 'retail_sales_qualification_writer_source_drift'; end if;
  definition:=replace(definition,declaration,declaration||E'\n  v_sales_qualification public.retail_existing_sales_qualifications;\n  v_sales_offer jsonb;');
  addition:=$insert$
  if v_retail_months > 0 and v_intent.channel='sales_assisted' then
    if v_intent.created_by_user_id is null or not exists(select 1 from public.sales_reps where user_id=v_intent.created_by_user_id)
    then raise exception 'retail_sales_qualification_original_rep_required'; end if;
    v_sales_offer:=v_intent.package_snapshot->'membership_terms';
    insert into public.retail_existing_sales_qualifications(
      purchase_intent_id,agreement_id,client_id,rep_user_id,terms_digest,platform_cap_cents,payment_kind,
      original_start_at,original_term_end_at,commission_window_end_at,qualification_closed_at
    ) values (
      v_intent.id,v_agreement.id,v_client_id,v_intent.created_by_user_id,
      public.retail_existing_sales_terms_digest(v_sales_offer),(v_sales_offer->>'platform_payment_cents')::bigint,
      case when v_sales_offer->>'payment_option'='prepaid' then 'paid_in_full' else 'monthly' end,
      v_retail_anchor,public.retail_existing_month_anchor(v_retail_anchor,v_retail_months),
      public.retail_existing_month_anchor(v_retail_anchor,12),v_retail_anchor
    ) on conflict(purchase_intent_id) do nothing;
    select * into v_sales_qualification from public.retail_existing_sales_qualifications where purchase_intent_id=v_intent.id;
    if not found or (v_sales_qualification.agreement_id,v_sales_qualification.client_id,v_sales_qualification.rep_user_id,
      v_sales_qualification.terms_digest,v_sales_qualification.platform_cap_cents,v_sales_qualification.payment_kind,
      v_sales_qualification.original_start_at,v_sales_qualification.original_term_end_at,
      v_sales_qualification.commission_window_end_at,v_sales_qualification.qualification_closed_at)
      is distinct from(v_agreement.id,v_client_id,v_intent.created_by_user_id,
        public.retail_existing_sales_terms_digest(v_sales_offer),(v_sales_offer->>'platform_payment_cents')::bigint,
        case when v_sales_offer->>'payment_option'='prepaid' then 'paid_in_full' else 'monthly' end,
        v_retail_anchor,public.retail_existing_month_anchor(v_retail_anchor,v_retail_months),
        public.retail_existing_month_anchor(v_retail_anchor,12),v_retail_anchor)
    then raise exception 'retail_sales_qualification_replay_mismatch'; end if;
  end if;
$insert$;
  definition:=replace(definition,marker,addition||marker);
  execute definition;
  if not exists(select 1 from pg_proc where oid=proc_oid and proacl is not distinct from original_acl
    and proowner=original_owner and prosecdef and proconfig is not distinct from original_config)
  then raise exception 'retail_sales_qualification_writer_privilege_drift'; end if;
end $patch$;
commit;
