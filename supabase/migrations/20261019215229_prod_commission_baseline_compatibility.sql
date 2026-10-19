-- Production compatibility for existing receipt ledger; no renames/backfills.
begin;
set local lock_timeout='10s';
lock table public.sales_commission_receipts, public.sales_commission_adjustments,public.sales_commission_payouts,public.sales_commission_departures in share row exclusive mode;
do $$ declare p record;begin
 select * into p from pg_proc where oid='public.check_sales_commission_departure_cutoff()'::regprocedure;
 if md5(p.prosrc)<>'a25a71cbc7398bf374cb11c00d2d9993' or p.prosecdef or p.proconfig is not null
   or p.proowner<>'postgres'::regrole or p.proacl is distinct from array['postgres=X/postgres']::aclitem[]
   or to_regprocedure('public.require_sales_commission_sales_assisted()') is not null
   or (select count(*) from pg_trigger where tgfoid=p.oid and not tgisinternal)<>2
   or not exists(select 1 from pg_trigger where tgrelid='public.sales_commission_receipts'::regclass and tgname='sales_commission_receipt_cutoff_guard' and tgfoid=p.oid and tgenabled='O' and tgtype=7)
   or not exists(select 1 from pg_trigger where tgrelid='public.sales_commission_departures'::regclass and tgname='sales_commission_departure_cutoff_guard' and tgfoid=p.oid and tgenabled='O' and tgtype=7)
   or exists(select 1 from public.sales_commission_receipts) or exists(select 1 from public.sales_commission_adjustments)
   or exists(select 1 from public.sales_commission_payouts) or exists(select 1 from public.sales_commission_statement_locks)
 then raise exception 'prod_commission_baseline_drift';end if;
end $$;
-- The older production ledger retained default DELETE/TRUNCATE grants.
-- Repeat the existing QA ledger containment, never weaken the pricing guard.
do $$declare table_ text;begin
 foreach table_ in array array['sales_commission_departures','sales_commission_receipts','sales_commission_adjustments','sales_commission_payouts','sales_commission_statement_locks'] loop
  if not exists(select 1 from pg_class where oid=to_regclass('public.'||table_) and relrowsecurity
    and relacl=array['postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::aclitem[])
    or has_table_privilege('anon',to_regclass('public.'||table_),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated',to_regclass('public.'||table_),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   then raise exception 'prod_commission_acl_baseline_drift';end if;
 end loop;
 foreach table_ in array array['sales_commission_bank_transactions','sales_commission_bank_reversals','sales_commission_bank_api_bindings'] loop
  if not exists(select 1 from pg_class where oid=to_regclass('public.'||table_) and relrowsecurity
    and relacl=array['postgres=arwdDxtm/postgres','service_role=rDxtm/postgres']::aclitem[])
   then raise exception 'prod_commission_bank_acl_baseline_drift';end if;
 end loop;
end $$;
revoke delete,truncate on public.sales_commission_departures,public.sales_commission_receipts,
 public.sales_commission_adjustments,public.sales_commission_payouts,public.sales_commission_statement_locks from service_role;
revoke all on public.sales_commission_bank_transactions,public.sales_commission_bank_reversals,public.sales_commission_bank_api_bindings from service_role;
grant select on public.sales_commission_bank_transactions,public.sales_commission_bank_reversals,public.sales_commission_bank_api_bindings to service_role;
CREATE OR REPLACE FUNCTION public.check_sales_commission_departure_cutoff()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  final_day_recorded date;
  cutoff_exclusive timestamptz;
begin
  -- Serialize a final-day entry and a receipt for the same representative.
  -- Without this lock, concurrent uncommitted inserts can each miss the other.
  perform pg_advisory_xact_lock(hashtextextended('commission_departure:' || new.rep_user_id::text, 0));
  if tg_table_name = 'sales_commission_departures' then
    cutoff_exclusive := (new.final_day + 31)::timestamp at time zone 'America/Denver';
    if exists (
      select 1 from public.sales_commission_receipts r
      where r.rep_user_id = new.rep_user_id and
        (r.payment_success_at >= cutoff_exclusive or r.qualification_closed_at >= cutoff_exclusive)
    ) then
      raise exception 'existing_receipt_exceeds_departure_cutoff';
    end if;
  else
    select d.final_day into final_day_recorded from public.sales_commission_departures d
      where d.rep_user_id = new.rep_user_id;
    if final_day_recorded is distinct from new.rep_final_day then
      raise exception 'receipt_departure_snapshot_mismatch';
    end if;
    if final_day_recorded is not null then
      cutoff_exclusive := (final_day_recorded + 31)::timestamp at time zone 'America/Denver';
      if new.payment_success_at >= cutoff_exclusive or new.qualification_closed_at >= cutoff_exclusive then
        raise exception 'receipt_exceeds_departure_cutoff';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.require_sales_commission_sales_assisted()
returns trigger language plpgsql set search_path = '' as $$
declare
  intent_id uuid;
  representative_id uuid;
begin
  if tg_table_name = 'sales_commission_receipts' then
    intent_id := new.purchase_intent_id;
    representative_id := new.rep_user_id;
  else
    select r.purchase_intent_id, r.rep_user_id into intent_id, representative_id
    from public.sales_commission_receipts r where r.id = new.receipt_id;
  end if;
  if intent_id is null or not exists (
    select 1 from public.public_purchase_intents i
    where i.id = intent_id and i.channel = 'sales_assisted'
      and i.status = 'completed' and i.created_by_user_id = representative_id
  ) then
    raise exception 'commission_sale_not_sales_assisted';
  end if;
  return new;
end;
$$;
create trigger sales_commission_receipt_attribution before insert on public.sales_commission_receipts
  for each row execute function public.require_sales_commission_sales_assisted();
create trigger sales_commission_adjustment_attribution before insert on public.sales_commission_adjustments
  for each row execute function public.require_sales_commission_sales_assisted();
create trigger sales_commission_payout_attribution before insert on public.sales_commission_payouts
  for each row execute function public.require_sales_commission_sales_assisted();

revoke all on function public.require_sales_commission_sales_assisted() from public,anon,authenticated,service_role;
-- Match the already-reviewed sales-assisted review queue; not self-service sales.
do $$declare original_acl aclitem[];original_owner oid;expected text;actual text;begin
 create temporary view prod_expected_review_queue as
 select i.id,i.company_legal_name,i.buyer_email,i.selected_plan_key,i.selected_billing_cadence,i.created_by_user_id,i.activated_at
 from public.public_purchase_intents i join public.membership_agreements a on a.id=i.agreement_id and a.client_id=i.client_id
 join public.clients c on c.id=i.client_id
 where i.status='completed' and i.activated_at is not null and i.created_by_user_id is not null
 and a.status='signed' and a.checkout_status='paid' and a.signed_at is not null and a.checkout_paid_at is not null
 and c.billing_status='active' and coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') in('active','trialing');
 select pg_get_viewdef('pg_temp.prod_expected_review_queue'::regclass,false) into expected;
 select pg_get_viewdef(oid,false),relowner,relacl into actual,original_owner,original_acl from pg_class
 where oid='public.sales_commission_review_candidates'::regclass and reloptions=array['security_invoker=true'];
 if actual is distinct from expected or original_owner is distinct from 'postgres'::regrole::oid
 or original_acl is distinct from array['postgres=arwdDxtm/postgres','service_role=rDxtm/postgres']::aclitem[]
 then raise exception 'prod_commission_review_view_baseline_drift';end if;
 create or replace view public.sales_commission_review_candidates with(security_invoker=true) as
 select i.id,i.company_legal_name,i.buyer_email,i.selected_plan_key,i.selected_billing_cadence,i.created_by_user_id,i.activated_at
 from public.public_purchase_intents i join public.membership_agreements a on a.id=i.agreement_id and a.client_id=i.client_id
 join public.clients c on c.id=i.client_id
 where i.status='completed' and i.channel='sales_assisted' and i.activated_at is not null and i.created_by_user_id is not null
 and a.status='signed' and a.checkout_status='paid' and a.signed_at is not null and a.checkout_paid_at is not null
 and c.billing_status='active' and coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') in('active','trialing');
 if not exists(select 1 from pg_class where oid='public.sales_commission_review_candidates'::regclass and relowner=original_owner and relacl is not distinct from original_acl)
 then raise exception 'prod_commission_review_view_preservation_failed';end if;
 drop view pg_temp.prod_expected_review_queue;
end $$;
do $$begin
 if not exists(select 1 from pg_proc where oid='public.check_sales_commission_departure_cutoff()'::regprocedure and md5(prosrc)='030f985df12a23358849d9343cf70b80' and proacl=array['postgres=X/postgres']::aclitem[] and not prosecdef)
   or not exists(select 1 from pg_proc where oid='public.require_sales_commission_sales_assisted()'::regprocedure and md5(prosrc)='f7f482687118008250aa3404e47cc715' and not prosecdef and proconfig=array['search_path=""'])
 then raise exception 'prod_commission_compatibility_failed';end if;
end $$;
commit;
