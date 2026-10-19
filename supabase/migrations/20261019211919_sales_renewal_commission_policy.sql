-- New receipt approvals only. No historical receipt or contract rewrite.
begin;
set local lock_timeout='10s';

create table public.sales_renewal_commission_policy_events (
  version bigint generated always as identity primary key check(version between 1 and 9007199254740991),
  enabled boolean not null,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by_user_id uuid not null references auth.users(id) on delete restrict
);
alter table public.sales_renewal_commission_policy_events enable row level security;
revoke all on public.sales_renewal_commission_policy_events from public,anon,authenticated,service_role;
grant select,insert on public.sales_renewal_commission_policy_events to service_role;
revoke all on sequence public.sales_renewal_commission_policy_events_version_seq from public,anon,authenticated,service_role;
grant usage on sequence public.sales_renewal_commission_policy_events_version_seq to service_role;

create function public.reject_sales_renewal_commission_policy_mutation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  raise exception 'renewal_commission_policy_immutable';
end $$;
create trigger sales_renewal_commission_policy_immutable before update or delete
on public.sales_renewal_commission_policy_events for each row
execute function public.reject_sales_renewal_commission_policy_mutation();

create function public.set_sales_renewal_commissions(p_enabled boolean,p_expected_version bigint,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare current_version bigint; current_enabled boolean; changed timestamptz;
begin
  if p_enabled is null or p_actor is null or p_expected_version is null or p_expected_version<0
    or p_expected_version>9007199254740991 then raise exception 'invalid_renewal_commission_confirmation';end if;
  -- Shared receipt admission vs exclusive policy change, held until transaction end.
  perform pg_catalog.pg_advisory_xact_lock(17673944,3192026);
  select version,enabled,changed_at into current_version,current_enabled,changed
    from public.sales_renewal_commission_policy_events order by version desc limit 1;
  current_version:=coalesce(current_version,0); current_enabled:=coalesce(current_enabled,false);
  if current_version<>p_expected_version then raise exception 'renewal_commission_policy_changed';end if;
  if current_enabled is distinct from p_enabled then
    insert into public.sales_renewal_commission_policy_events(enabled,changed_by_user_id)
    values(p_enabled,p_actor) returning version,enabled,changed_at into current_version,current_enabled,changed;
  end if;
  return jsonb_build_object('enabled',current_enabled,'version',current_version,'changed_at',changed);
end $$;

create function public.sales_commission_receipt_is_renewal(r jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare protocol_ text:=r->>'membership_terms_protocol'; terms_ jsonb; funding_ jsonb; proof_ jsonb;
  ordinal_ integer; months_ integer; period_start_ bigint;
begin
  if current_user<>'service_role' then raise exception 'renewal_commission_source_denied';end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(17673944,3192026);
  if protocol_='retail_existing_terms_v2' then
    -- Reuse the existing native financial/source checks under the policy lock.
    perform public.retail_existing_assert_commission_receipt(r,false);
    select i.package_snapshot->'membership_terms',a.retail_funding_receipt into strict terms_,funding_
      from public.public_purchase_intents i join public.membership_agreements a on a.id=i.agreement_id
      where i.id=(r->>'purchase_intent_id')::uuid;
    if terms_->>'offer_version' in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3') then
      if funding_#>>'{proof,period,invoice_id}'=r->>'provider_payment_id' then ordinal_:=0;
      else
        select (retail_period_receipt#>>'{proof,ordinal}')::integer into strict ordinal_
          from public.billing_invoices where stripe_invoice_id=r->>'provider_payment_id';
      end if;
      months_:=(terms_->>'commitment_months')::integer;
      if ordinal_ is null or ordinal_<0 or ordinal_>999 or months_ not in(3,6,12)
        or terms_->>'payment_option' not in('prepaid','monthly_installments')
        then raise exception 'renewal_commission_source_denied';end if;
      return case when terms_->>'payment_option'='prepaid' then ordinal_>=1 else ordinal_>=months_ end;
    elsif terms_->>'offer_version'='retail-terms-2026-10-11-v1' then
      -- Historical payment-mode offer has no recurring period proof/ordinal.
      return (r->>'payment_success_at')::timestamptz >= (r->>'first_term_end_at')::timestamptz;
    else raise exception 'renewal_commission_source_denied';end if;
  elsif protocol_='enterprise_existing_terms_v1' then
    perform public.enterprise_existing_assert_commission_receipt(r,false);
    proof_:=public.read_enterprise_existing_commission_payment((r->>'enterprise_agreement_id')::uuid,
      (r#>>'{enterprise_commission_source,client_id}')::uuid,r->>'provider_payment_id',
      (r->>'rep_user_id')::uuid,true);
    ordinal_:=(proof_->>'ordinal')::integer;
    if ordinal_=0 then return false;end if;
    select (enterprise_period_receipt#>>'{proof,provider_period_start}')::bigint into strict period_start_
      from public.billing_invoices where stripe_invoice_id=r->>'provider_payment_id';
    if ordinal_ is null or ordinal_<1 or ordinal_>999 or period_start_ is null or period_start_<=0
      then raise exception 'renewal_commission_source_denied';end if;
    return to_timestamp(period_start_) >= (proof_#>>'{qualification,original_term_end_at}')::timestamptz;
  elsif protocol_='retail_terms_v2' then
    -- Retired first-payment-only protocol has no provider ordinal. Its existing
    -- immutable qualification end is the only supported boundary for that cohort.
    return (r->>'payment_success_at')::timestamptz >= (r->>'first_term_end_at')::timestamptz;
  elsif protocol_='legacy_receipt_v1' then return false;
  else raise exception 'renewal_commission_source_denied';end if;
end $$;

create function public.check_sales_renewal_commission_policy()
returns trigger language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare enabled_ boolean; renewal_ boolean;
begin
  renewal_:=public.sales_commission_receipt_is_renewal(to_jsonb(new));
  if renewal_ is null then raise exception 'renewal_commission_source_denied';end if;
  if renewal_ then
    select enabled into enabled_ from public.sales_renewal_commission_policy_events order by version desc limit 1;
    if coalesce(enabled_,false) is not true then raise exception 'renewal_commissions_disabled';end if;
  end if;
  return new;
end $$;
create trigger sales_commission_receipts_renewal_policy before insert on public.sales_commission_receipts
for each row execute function public.check_sales_renewal_commission_policy();

revoke all on function public.reject_sales_renewal_commission_policy_mutation(),
  public.set_sales_renewal_commissions(boolean,bigint,uuid),public.check_sales_renewal_commission_policy(),public.sales_commission_receipt_is_renewal(jsonb)
  from public,anon,authenticated;
grant execute on function public.reject_sales_renewal_commission_policy_mutation(),
  public.set_sales_renewal_commissions(boolean,bigint,uuid),public.check_sales_renewal_commission_policy(),public.sales_commission_receipt_is_renewal(jsonb)
  to service_role;
commit;
