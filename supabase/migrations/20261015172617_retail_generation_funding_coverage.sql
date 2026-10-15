-- Prospective v3 ONLY, on the existing receipt/activation/period/renewal paths.
-- No backfill, catalog flip, Auth redesign, provider call or new payment engine.
begin;
set local lock_timeout='10s';
create temporary table generation_function_baseline on commit drop as
 select p.oid::regprocedure::text as signature,md5(p.prosrc) as hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public';
do $baseline$
declare spec text[];p record;
begin
 foreach spec slice 1 in array array[
  array['retail_existing_funding_receipt_valid(jsonb,jsonb)','de85fb9626933c9b7ed4525d53e3c183'],
  array['retail_existing_funding_guard()','3a6e1e9d7014ad5951dda1686bdfa2d9'],
  array['retail_existing_funding_schema_guard()','abfab9e6f97d88c8aa940b8a993db42b'],
  array['complete_public_purchase_activation(uuid,text,timestamptz,text,uuid,boolean,text,text,date,date)','c54ff125f87feddc1ccb3fc907b0d9bf'],
  array['apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)','c00171923a56c63735f753a430aee2e4'],
  array['apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb,jsonb)','f6092d3b6212899ea914d43ff7531047'],
  array['retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer)','6700729fe1e629e2cb0914fb8038b78a'],
  array['retail_admin_existing_member_context(uuid,jsonb,jsonb,jsonb)','550c4c9110a525944e77e009dd44271d'],
  array['retail_linked_existing_member_context(uuid,text,text,jsonb)','757cecae110bd8b907a8d9d861d039a0'],
  array['read_retail_existing_recurring_source(uuid,uuid)','aa46d6e39957f57380b76c358d8ced8e'],
  array['retail_existing_period_proof_valid(jsonb,jsonb)','89058f7dee22ac2d3077ddfacc84ac4e'],
  array['record_retail_existing_paid_period(uuid,uuid,jsonb,jsonb)','d827750be84c493c9b02b208f9b934c6'],
  array['refresh_retail_existing_paid_coverage(uuid,uuid)','9edc65c09fdb60df37926783b17b7737'],
  array['retail_existing_renewal_projection_valid(jsonb,jsonb)','80cfe616019410997e7ed3691f54ba83'],
  array['change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)','41981c8f4cc80f636167bd7b77a5ab0e'],
  array['retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)','dbb1df217cc92d7e6e71f806ea85107a'],
  array['retail_existing_assert_commission_receipt(jsonb,boolean)','5f3964c7af9096cc0bb5f936d4c8fb64'],
  array['retail_admin_existing_billing_schema_guard()','4c887b3dff537448d25372c7834a5b3b'],
  array['retail_admin_existing_member_schema_guard()','6b035717e48b44052c9bc08900d6d295'],
  array['retail_linked_existing_member_schema_guard()','5f0941dcca922ac7d8f629399304d89f']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(p.prosrc) is distinct from spec[2] or p.proisstrict
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.prosecdef is distinct from(spec[1] like 'complete_public_purchase_activation(%' or spec[1] like 'apply_public_purchase_billing(%')
   or p.provolatile is distinct from(case when spec[1] in('retail_existing_funding_receipt_valid(jsonb,jsonb)',
    'retail_existing_period_proof_valid(jsonb,jsonb)','retail_existing_renewal_projection_valid(jsonb,jsonb)',
    'retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer)') then 'i'::"char"
    when spec[1] like '%schema_guard()' then 's'::"char" else 'v'::"char" end)
   or p.proconfig is distinct from(case
    when spec[1] like 'complete_public_purchase_activation(%' or spec[1] like 'apply_public_purchase_billing(%' then array['search_path=""']
    when spec[1]='retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)' then array['search_path=pg_catalog','lock_timeout=10s','statement_timeout=2s']
    when spec[1] like '%schema_guard()' or spec[1] in('retail_existing_funding_receipt_valid(jsonb,jsonb)','retail_existing_funding_guard()',
     'retail_existing_period_proof_valid(jsonb,jsonb)','retail_existing_renewal_projection_valid(jsonb,jsonb)',
     'retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer)','retail_existing_assert_commission_receipt(jsonb,boolean)')
     then array['search_path=pg_catalog'] else array['search_path=pg_catalog','lock_timeout=10s'] end)
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_generation_funding_prerequisite_drift: %',spec[1];end if;
 end loop;
 if to_regprocedure('public.retail_generation_funding_valid(jsonb,jsonb)') is not null
  or to_regprocedure('public.retail_generation_coverage(jsonb,timestamptz)') is not null
  then raise exception 'retail_generation_funding_schema_drift';end if;
end $baseline$;

-- The same envelope/identity/index paths, a DIFFERENT closed evidence type.
-- Positive captured platform cash owns the period; trialing alone never does.
create function public.retail_generation_funding_valid(w jsonb,s jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare p jsonb:=w->'proof';b jsonb:=p->'period';o jsonb:=s->'template_snapshot'->'package_snapshot'->'membership_terms';
 cal jsonb;k text;paid timestamptz;recorded timestamptz;first_at timestamptz;trial_at timestamptz;
begin
 if not coalesce(public.retail_existing_closed_object(w,array['version','proof','recorded_at']),false)
  or w->>'version' is distinct from 'retail_existing_funding_v1'
  or not coalesce(public.retail_existing_closed_object(p,array['provider_account_id','period','payment_intent_id','charge_id',
   'checkout_created','invoice_created','platform_gross_cents','platform_discount_cents','platform_net_cents',
   'role_gross_cents','role_discount_cents','role_net_cents','tax_cents','cash_cents']),false)
  or not coalesce(public.retail_existing_closed_object(b,array['version','api_version','generated_at','initial_term_start',
   'initial_renewal_date','first_collection_at','invoice_id','initial_platform_invoice_line_id','recurring_invoice_line_id',
   'initial_platform_price_id','recurring_platform_price_id','first_role_price_id','subscription_id','subscription_item_id',
   'customer_id','checkout_session_id','livemode','paid_at','provider_trial_start','provider_trial_end','billing_cycle_anchor']),false)
  or b->>'version' is distinct from 'retail_generation_initial_schedule_v1'
  or b->>'api_version' is distinct from '2023-10-16' or jsonb_typeof(b->'livemode') is distinct from 'boolean'
  or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-15-v3'
  or s->'template_snapshot'->'package_snapshot' is distinct from public.retail_existing_package(o)
  then return false;end if;
 cal:=public.retail_generation_calendar(jsonb_build_object('template_snapshot',s->'template_snapshot',
  'initial_term_start',s->'template_snapshot'->'values'->'initial_term_start',
  'initial_renewal_date',s->'template_snapshot'->'values'->'initial_renewal_date'));
 foreach k in array array['generated_at','initial_term_start','initial_renewal_date','first_collection_at'] loop
  if b->k is distinct from cal->k then return false;end if;
 end loop;
 if not public.retail_generation_prices_valid(jsonb_build_object('initial_platform_price_id',b->'initial_platform_price_id',
  'recurring_platform_price_id',b->'recurring_platform_price_id','first_role_price_id',b->'first_role_price_id'),o)
  or b->>'customer_id' is distinct from s->>'customer_id'
  or b->>'initial_platform_invoice_line_id'=b->>'recurring_invoice_line_id' then return false;end if;
 foreach k in array array['provider_account_id','payment_intent_id','charge_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>255
   or p->>k !~ ((case k when 'provider_account_id' then '^acct_' when 'payment_intent_id' then '^pi_' else '^ch_' end)||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 foreach k in array array['invoice_id','initial_platform_invoice_line_id','recurring_invoice_line_id',
  'subscription_id','subscription_item_id','customer_id','checkout_session_id'] loop
  if jsonb_typeof(b->k) is distinct from 'string' or length(b->>k)>255
   or b->>k !~ ((case k when 'invoice_id' then '^in_' when 'initial_platform_invoice_line_id' then '^il_'
    when 'recurring_invoice_line_id' then '^il_' when 'subscription_id' then '^sub_' when 'subscription_item_id' then '^si_'
    when 'customer_id' then '^cus_' else '^cs_' end)||'[A-Za-z0-9_]+$') then return false;end if;
 end loop;
 foreach k in array array['checkout_created','invoice_created','platform_gross_cents','platform_discount_cents','platform_net_cents',
  'role_gross_cents','role_discount_cents','role_net_cents','tax_cents','cash_cents'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$' or length(p->>k)>16
   or(p->>k)::numeric>9007199254740991 then return false;end if;
 end loop;
 foreach k in array array['provider_trial_start','provider_trial_end','billing_cycle_anchor'] loop
  if jsonb_typeof(b->k) is distinct from 'number' or b->>k !~ '^[0-9]+$' or length(b->>k)>12
   or(b->>k)::numeric not between 1 and 253402300799 then return false;end if;
 end loop;
 if jsonb_typeof(b->'paid_at') is distinct from 'string' or jsonb_typeof(w->'recorded_at') is distinct from 'string'
  then return false;end if;
 paid:=(b->>'paid_at')::timestamptz;recorded:=(w->>'recorded_at')::timestamptz;
 first_at:=(cal->>'first_collection_at')::timestamptz;trial_at:=to_timestamp((b->>'provider_trial_start')::bigint);
 return coalesce(isfinite(paid) and isfinite(recorded) and recorded>=paid
  and b->>'paid_at'=to_char(paid at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"')
  and w->>'recorded_at'=to_char(recorded at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  and paid>=(s->>'signed_at')::timestamptz and (s->>'signed_at')::timestamptz>=(cal->>'generated_at')::timestamptz
  and paid<(s->>'agreement_expires_at')::timestamptz
  and (s->'intent' is null or s->'intent'='null'::jsonb or paid<(s->'intent'->>'expires_at')::timestamptz)
  and paid<first_at and trial_at>=(cal->>'generated_at')::timestamptz and trial_at<=paid
  and (p->>'checkout_created')::numeric between 1 and 253402300799
  and (p->>'invoice_created')::numeric between 1 and 253402300799
  and (p->>'checkout_created')::numeric<=extract(epoch from trial_at)
  and extract(epoch from trial_at)<=(p->>'invoice_created')::numeric
  and (p->>'invoice_created')::numeric<=extract(epoch from paid)
  and (b->>'provider_trial_end')::numeric=extract(epoch from first_at)
  and b->'billing_cycle_anchor'=b->'provider_trial_end'
  and (p->>'platform_gross_cents')::numeric=(o->>'platform_payment_cents')::numeric
  and (p->>'role_gross_cents')::numeric=(o->'first_role_prepay'->>'amount_cents')::numeric
  and (p->>'platform_discount_cents')::numeric<=(p->>'platform_gross_cents')::numeric
  and (p->>'role_discount_cents')::numeric<=(p->>'role_gross_cents')::numeric
  and (p->>'platform_net_cents')::numeric=(p->>'platform_gross_cents')::numeric-(p->>'platform_discount_cents')::numeric
  and (p->>'platform_net_cents')::numeric>0
  and (p->>'role_net_cents')::numeric=(p->>'role_gross_cents')::numeric-(p->>'role_discount_cents')::numeric
  and (p->>'cash_cents')::numeric=(p->>'platform_net_cents')::numeric+(p->>'role_net_cents')::numeric+(p->>'tax_cents')::numeric
  and (o->>'payment_option'<>'prepaid' or ((p->>'platform_discount_cents')::numeric=0 and (p->>'role_discount_cents')::numeric=0)),false);
exception when others then return false;
end $$;

-- Same contiguous-prefix/C-window calculation used by the coverage writer.
-- Read-only geometry for current native setting/notice decisions, not a grant
-- of access. Caller supplies a fresh SQL clock after its existing row locks.
create function public.retail_generation_coverage(s jsonb,clock_ timestamptz)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare o jsonb:=s->'package_snapshot'->'membership_terms';b jsonb:=s->'original_period';w jsonb;r record;
 c public.clients;a timestamptz;until_at timestamptz;term_at timestamptz;end_at timestamptz;cutoff timestamptz;
 prefix integer:=0;n integer;span integer;months integer;t integer;funded integer;
begin
 if current_user<>'service_role' or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-15-v3'
  or not isfinite(clock_) or s is distinct from public.read_retail_existing_recurring_source(
   (s->>'agreement_id')::uuid,(s->>'client_id')::uuid) then raise exception 'retail_generation_coverage_source_denied';end if;
 select * into strict c from public.clients where id=(s->>'client_id')::uuid;
 perform 1 from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=s->>'agreement_id' order by id for share;
 if(select count(*) from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=s->>'agreement_id')>999
  then raise exception 'retail_period_coverage_incomplete';end if;
 for r in select * from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=s->>'agreement_id'
  order by(retail_period_receipt->'proof'->>'ordinal')::integer loop
  w:=r.retail_period_receipt;
  if not coalesce(public.retail_existing_closed_object(w,array['version','source','source_digest','proof','recorded_at']),false)
   or w->>'version' is distinct from 'retail_existing_paid_period_receipt_v1'
   or w->'source' is distinct from s or w->>'source_digest' is distinct from md5(s::text)
   or not coalesce(public.retail_existing_period_proof_valid(w->'proof',s),false)
   or r.stripe_invoice_id is distinct from w->'proof'->>'invoice_id'
   or not exists(select 1 from public.billing_customers where id=r.billing_customer_id and client_id=c.id and stripe_customer_id=c.stripe_customer_id)
   or jsonb_typeof(w->'recorded_at') is distinct from 'string' or not isfinite((w->>'recorded_at')::timestamptz)
   or(w->>'recorded_at')::timestamptz<(w->'proof'->>'paid_at')::timestamptz
   or(w->>'recorded_at')::timestamptz>clock_ or(w->'proof'->>'paid_at')::timestamptz>clock_
   then raise exception 'retail_period_coverage_denied';end if;
  n:=(w->'proof'->>'ordinal')::integer;if n=prefix+1 then prefix:=n;end if;
 end loop;
 a:=(b->>'initial_term_start')::date::timestamp at time zone 'UTC';
 span:=(o->'stripe_recurrence'->>'interval_count')::integer;months:=(o->>'commitment_months')::integer;
 until_at:=public.retail_existing_month_anchor(a,(prefix+1)*span);
 t:=greatest(0,((extract(year from clock_ at time zone 'UTC')::integer-extract(year from a at time zone 'UTC')::integer)*12
  +extract(month from clock_ at time zone 'UTC')::integer-extract(month from a at time zone 'UTC')::integer)/months);
 while t>0 and public.retail_existing_month_anchor(a,t*months)>clock_ loop t:=t-1;end loop;
 funded:=case when o->>'payment_option'='prepaid' then prefix else prefix/months end;t:=least(t,funded);
 term_at:=public.retail_existing_month_anchor(a,t*months);end_at:=public.retail_existing_month_anchor(a,(t+1)*months);
 cutoff:=public.retail_existing_month_anchor((b->>'first_collection_at')::timestamptz,(t+1)*months-span);
 return jsonb_build_object('contiguous_ordinal',prefix,'funded_through',until_at,'term_index',t,
  'contract_start_at',term_at,'contract_end_at',end_at,'billing_cutoff_at',cutoff);
end $$;
revoke all on function public.retail_generation_funding_valid(jsonb,jsonb),public.retail_generation_coverage(jsonb,timestamptz)
 from public,anon,authenticated;
grant execute on function public.retail_generation_funding_valid(jsonb,jsonb),public.retail_generation_coverage(jsonb,timestamptz)
 to service_role;

-- Native consumers are patched atomically below before this migration commits.
create temporary table generation_patch_buffer(signature text primary key,definition text not null) on commit drop;
create function pg_temp.generation_patch(sig text,needle text,addition text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare d text;
begin
 select definition into d from pg_temp.generation_patch_buffer where signature=sig;
 if not found then select pg_get_functiondef(to_regprocedure('public.'||sig)) into d;end if;
 if d is null or length(needle)=0 or (length(d)-length(replace(d,needle,'')))/length(needle)<>1
  then raise exception 'retail_generation_funding_patch_drift: % / %',sig,left(needle,80);end if;
 insert into pg_temp.generation_patch_buffer values(sig,replace(d,needle,addition))
  on conflict(signature) do update set definition=excluded.definition;
end $$;
revoke all on function pg_temp.generation_patch(text,text,text) from public,anon,authenticated,service_role;

select pg_temp.generation_patch('retail_existing_funding_receipt_valid(jsonb,jsonb)',
 $old$begin
 if not coalesce(public.retail_existing_closed_object(w,$old$,
 $new$begin
 if offer->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
  return public.retail_generation_funding_valid(w,s);end if;
 if not coalesce(public.retail_existing_closed_object(w,$new$);

select pg_temp.generation_patch('retail_existing_funding_guard()',
 $old$ new.retail_funding_receipt:=w;return new;$old$,
 $new$ if new.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
  if new.retail_checkout_prices is distinct from jsonb_build_object(
    'initial_platform_price_id',w->'proof'->'period'->'initial_platform_price_id',
    'recurring_platform_price_id',w->'proof'->'period'->'recurring_platform_price_id',
    'first_role_price_id',w->'proof'->'period'->'first_role_price_id')
   or public.retail_generation_calendar(to_jsonb(new)) is distinct from jsonb_build_object(
    'generated_at',w->'proof'->'period'->'generated_at','initial_term_start',w->'proof'->'period'->'initial_term_start',
    'initial_renewal_date',w->'proof'->'period'->'initial_renewal_date','first_collection_at',w->'proof'->'period'->'first_collection_at')
   then raise exception 'retail_generation_funding_binding_denied';end if;
 end if;
 new.retail_funding_receipt:=w;return new;$new$);

select pg_temp.generation_patch('complete_public_purchase_activation(uuid,text,timestamptz,text,uuid,boolean,text,text,date,date)',
 $old$or p_term_start is distinct from (v_retail_anchor at time zone 'UTC')::date$old$,
 $new$or p_term_start is distinct from (case when v_intent.term_start_basis='generation_date' then v_agreement.initial_term_start
        else (v_retail_anchor at time zone 'UTC')::date end)$new$);
select pg_temp.generation_patch('complete_public_purchase_activation(uuid,text,timestamptz,text,uuid,boolean,text,text,date,date)',
 $old$or p_renewal_date is distinct from (public.retail_existing_month_anchor(v_retail_anchor,v_retail_months) at time zone 'UTC')::date$old$,
 $new$or p_renewal_date is distinct from (case when v_intent.term_start_basis='generation_date' then v_agreement.initial_renewal_date
        else (public.retail_existing_month_anchor(v_retail_anchor,v_retail_months) at time zone 'UTC')::date end)$new$);

select pg_temp.generation_patch('apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)',
 $old$    v_retail_anchor := v_agreement.checkout_paid_at;$old$,
 $new$    v_retail_anchor := case when v_intent.term_start_basis='generation_date'
      then v_agreement.initial_term_start::timestamp at time zone 'UTC' else v_agreement.checkout_paid_at end;
    if v_intent.term_start_basis='generation_date' and (p_subscription_status is distinct from 'trialing'
      or p_billing_status is distinct from 'active' or p_cancel_at_term_end is distinct from false
      or p_auto_renew is distinct from true or p_cancel_effective_at is not null
      or p_current_term_end is distinct from to_timestamp((v_agreement.retail_funding_receipt->'proof'->'period'->>'provider_trial_end')::bigint))
      then raise exception 'retail_generation_initial_payload_denied';end if;$new$);

-- Shared initial financial projections keep their existing source and return
-- shapes. The source offer selects C vs A and the actual initial native state.
do $initial$
declare sig text;anchor_ text;period_ text;status_ text;offer_ text;
begin
 foreach sig in array array['apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb,jsonb)',
  'retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer)'] loop
  offer_:='offer->>''offer_version''=''retail-stripe-terms-2026-10-15-v3''';
  anchor_:='(case when '||offer_||' then (proof->''period''->>''initial_term_start'')::date::timestamp at time zone ''UTC'' else (proof->''period''->>''paid_at'')::timestamptz end)';
  period_:='(case when '||offer_||' then proof->''period''->>''provider_trial_end'' else proof->''period''->>''provider_period_end'' end)';
  status_:='(case when '||offer_||' then ''trialing'' else ''active'' end)';
  perform pg_temp.generation_patch(sig,'start_at:=(proof->''period''->>''paid_at'')::timestamptz;', 'start_at:='||anchor_||';');
  perform pg_temp.generation_patch(sig,'period_at:=to_timestamp((proof->''period''->>''provider_period_end'')::bigint);',
   'period_at:=to_timestamp('||period_||'::bigint);');
  perform pg_temp.generation_patch(sig,'''status'',''active'',''current_period_end'',(proof->''period''->>''provider_period_end'')::bigint',
   '''status'','||status_||',''current_period_end'','||period_||'::bigint');
  perform pg_temp.generation_patch(sig,'''subscription_status'',''active'',''billing_status'',''active''',
   '''subscription_status'','||status_||',''billing_status'',''active''');
  if sig like 'apply_%' then
   perform pg_temp.generation_patch(sig,'subscription_status=''active'',billing_status=''active'',billing_interval=a.billing_option',
    'subscription_status=p_subscription->>''status'',billing_status=''active'',billing_interval=a.billing_option');
  end if;
 end loop;
end $initial$;

select pg_temp.generation_patch('retail_admin_existing_member_context(uuid,jsonb,jsonb,jsonb)',
 $old$c.subscription_status is distinct from 'active'$old$,
 $new$c.subscription_status is distinct from p_current->>'status'$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$end_at:=public.retail_existing_month_anchor(a.checkout_paid_at,months);$old$,
 $new$end_at:=public.retail_existing_month_anchor(case when a.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  then a.initial_term_start::timestamp at time zone 'UTC' else a.checkout_paid_at end,months);$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$period_at:=to_timestamp((period->>'provider_period_end')::bigint);$old$,
 $new$period_at:=to_timestamp((case when period->>'version'='retail_generation_initial_schedule_v1'
  then period->>'provider_trial_end' else period->>'provider_period_end' end)::bigint);$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$or p_current->>'status' is distinct from 'active' or p_current->'current_period_end' is distinct from period->'provider_period_end'$old$,
 $new$or p_current->>'status' is distinct from(case when period->>'version'='retail_generation_initial_schedule_v1' then 'trialing' else 'active' end)
  or p_current->'current_period_end' is distinct from(case when period->>'version'='retail_generation_initial_schedule_v1' then period->'provider_trial_end' else period->'provider_period_end' end)$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$between(period->>'provider_period_end')::numeric and 253402300799$old$,
 $new$between extract(epoch from period_at) and 253402300799$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$c.subscription_status is distinct from 'active'$old$,
 $new$c.subscription_status is distinct from p_current->>'status'$new$);
select pg_temp.generation_patch('retail_linked_existing_member_context(uuid,text,text,jsonb)',
 $old$c.contract_start_at is distinct from a.checkout_paid_at$old$,
 $new$c.contract_start_at is distinct from(case when period->>'version'='retail_generation_initial_schedule_v1'
  then a.initial_term_start::timestamp at time zone 'UTC' else a.checkout_paid_at end)$new$);

-- Cash/cycle proof keeps the SAME closed recurring receipt fields. Those are
-- real recurring provider periods, unlike the distinctly typed initial schedule.
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'$old$,
 $new$or coalesce(o->>'offer_version','') not in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3')
  or (o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and b->>'version' is distinct from 'retail_generation_initial_schedule_v1')$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$if p->k is distinct from b->k then return false;end if;$old$,
 $new$if p->k is distinct from(case when k='price_id' and o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
   then b->'recurring_platform_price_id' else b->k end) then return false;end if;$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$or p->'line_id' is not distinct from b->'platform_invoice_line_id'$old$,
 $new$or p->'line_id' is not distinct from b->'platform_invoice_line_id'
  or p->'line_id' is not distinct from b->'initial_platform_invoice_line_id'
  or p->'line_id' is not distinct from b->'recurring_invoice_line_id'$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$start_b:=to_timestamp((b->>'provider_period_start')::bigint);$old$,
 $new$start_b:=case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  then (b->>'first_collection_at')::timestamptz else to_timestamp((b->>'provider_period_start')::bigint) end;$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$or extract(epoch from public.retail_existing_month_anchor(start_b,span))<>(b->>'provider_period_end')::bigint$old$,
 $new$or (o->>'offer_version'<>'retail-stripe-terms-2026-10-15-v3'
   and extract(epoch from public.retail_existing_month_anchor(start_b,span))<>(b->>'provider_period_end')::bigint)$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$public.retail_existing_month_anchor(start_b,n*span)$old$,
 $new$public.retail_existing_month_anchor(start_b,(n-case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 1 else 0 end)*span)$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$public.retail_existing_month_anchor(start_b,(n+1)*span)$old$,
 $new$public.retail_existing_month_anchor(start_b,(n+case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 0 else 1 end)*span)$new$);
select pg_temp.generation_patch('retail_existing_period_proof_valid(jsonb,jsonb)',
 $old$ if cash=0 then$old$,
 $new$ if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and (net<=0 or(o->>'payment_option'='prepaid' and discount<>0)) then return false;end if;
 if cash=0 then$new$);
select pg_temp.generation_patch('record_retail_existing_paid_period(uuid,uuid,jsonb,jsonb)',
 $old$or x.retail_funding_receipt->'proof'->'period'->'platform_invoice_line_id'=p_proof->'line_id'$old$,
 $new$or x.retail_funding_receipt->'proof'->'period'->'platform_invoice_line_id'=p_proof->'line_id'
   or x.retail_funding_receipt->'proof'->'period'->'initial_platform_invoice_line_id'=p_proof->'line_id'
   or x.retail_funding_receipt->'proof'->'period'->'recurring_invoice_line_id'=p_proof->'line_id'$new$);
select pg_temp.generation_patch('refresh_retail_existing_paid_coverage(uuid,uuid)',
 $old$if o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'$old$,
 $new$if coalesce(o->>'offer_version','') not in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3')$new$);
select pg_temp.generation_patch('refresh_retail_existing_paid_coverage(uuid,uuid)',
 $old$a:=(s->'original_period'->>'paid_at')::timestamptz;$old$,
 $new$a:=case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  then (s->'original_period'->>'initial_term_start')::date::timestamp at time zone 'UTC'
  else(s->'original_period'->>'paid_at')::timestamptz end;$new$);
select pg_temp.generation_patch('retail_existing_assert_commission_receipt(jsonb,boolean)',
 $old$if i.package_snapshot->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-14-v2' then$old$,
 $new$if i.package_snapshot->'membership_terms'->>'offer_version' in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3') then$new$);

select pg_temp.generation_patch('retail_existing_renewal_projection_valid(jsonb,jsonb)',
 $old$or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'$old$,
 $new$or coalesce(o->>'offer_version','') not in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3')$new$);
select pg_temp.generation_patch('retail_existing_renewal_projection_valid(jsonb,jsonb)',
 $old$or p->'billing_cycle_anchor' is distinct from b->'provider_period_start'$old$,
 $new$or p->'billing_cycle_anchor' is distinct from(case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
   then b->'billing_cycle_anchor' else b->'provider_period_start' end)$new$);
select pg_temp.generation_patch('retail_existing_renewal_projection_valid(jsonb,jsonb)',
 $old$or p->>'status' is null or p->>'status' not in('active','past_due','unpaid','canceled')$old$,
 $new$or p->>'status' is null or (p->>'status' not in('active','past_due','unpaid','canceled')
   and not(o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and p->>'status'='trialing'))$new$);
select pg_temp.generation_patch('retail_existing_renewal_projection_valid(jsonb,jsonb)',
 $old$if p->k is distinct from b->k then return false;end if;$old$,
 $new$if p->k is distinct from(case when k='price_id' and o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
   then b->'recurring_platform_price_id' else b->k end) then return false;end if;$new$);
select pg_temp.generation_patch('retail_existing_renewal_projection_valid(jsonb,jsonb)',
 $old$start_b:=to_timestamp((b->>'provider_period_start')::bigint);start_p:=to_timestamp((p->>'current_period_start')::bigint);$old$,
 $new$if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
  if p->'current_period_start'=b->'provider_trial_start' and p->'current_period_end'=b->'provider_trial_end'
   and p->>'status' in('trialing','canceled') then return true;end if;
  if p->>'status'='trialing' then return false;end if;
 end if;
 start_b:=case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then (b->>'first_collection_at')::timestamptz
  else to_timestamp((b->>'provider_period_start')::bigint) end;start_p:=to_timestamp((p->>'current_period_start')::bigint);$new$);

select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'$old$,
 $new$or coalesce(o->>'offer_version','') not in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3')$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$if p_action='read' then return jsonb_build_object('status',coalesce(r->>'status','none'),'operation',r);end if;$old$,
 $new$if p_action='read' then return jsonb_build_object('status',coalesce(r->>'status','none'),'operation',r)
  ||case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then jsonb_build_object('billing_cutoff_at',
   to_char((public.retail_generation_coverage(s,clock)->>'billing_cutoff_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else '{}'::jsonb end;end if;$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$  months:=(o->>'commitment_months')::integer;$old$,
 $new$  if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
   cutoff:=(public.retail_generation_coverage(s,clock)->>'billing_cutoff_at')::timestamptz;
   if cutoff<=clock then raise exception 'retail_renewal_calendar_denied';end if;
  else
  months:=(o->>'commitment_months')::integer;$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$  if step>1000 then raise exception 'retail_renewal_calendar_denied';end if;$old$,
 $new$  if step>1000 then raise exception 'retail_renewal_calendar_denied';end if;
  end if;$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$else p_observation->'cancel_at_period_end'='true'::jsonb and to_timestamp((p_observation->>'cancel_at')::bigint)=cutoff end;$old$,
 $new$else (p_observation->'cancel_at_period_end'='true'::jsonb
     or (o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and p_observation->'cancel_at_period_end'='false'::jsonb))
    and to_timestamp((p_observation->>'cancel_at')::bigint)=cutoff end;$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$or to_timestamp((p_observation->>'current_period_end')::bigint)<>cutoff$old$,
 $new$or (case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
     then to_timestamp((p_observation->>'current_period_end')::bigint)>cutoff
      or (p_observation->'cancel_at_period_end'='true'::jsonb and to_timestamp((p_observation->>'current_period_end')::bigint)<>cutoff)
     else to_timestamp((p_observation->>'current_period_end')::bigint)<>cutoff end)$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$(p_observation->>'status'<>'active' or cutoff<=clock)$old$,
 $new$((p_observation->>'status'<>'active' and not(o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and p_observation->>'status'='trialing')) or cutoff<=clock)$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$or(p_action<>'finish' and obs->>'status'<>'active')$old$,
 $new$or(p_action<>'finish' and obs->>'status'<>'active' and not(o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and obs->>'status'='trialing'))$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$or to_timestamp((obs->>'current_period_end')::bigint)<>cutoff$old$,
 $new$or(case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
      then to_timestamp((obs->>'current_period_end')::bigint)>cutoff
       or(obs->'cancel_at_period_end'='true'::jsonb and to_timestamp((obs->>'current_period_end')::bigint)<>cutoff)
      else to_timestamp((obs->>'current_period_end')::bigint)<>cutoff end)$new$);
select pg_temp.generation_patch('change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb)',
 $old$obs->'cancel_at_period_end'<>'true'::jsonb
       or to_timestamp((obs->>'cancel_at')::bigint) is distinct from cutoff$old$,
 $new$(obs->'cancel_at_period_end'<>'true'::jsonb and not(o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and obs->'cancel_at_period_end'='false'::jsonb))
       or to_timestamp((obs->>'cancel_at')::bigint) is distinct from cutoff$new$);

select pg_temp.generation_patch('retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)',
 $old$or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'$old$,
 $new$or coalesce(o->>'offer_version','') not in('retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3')$new$);
select pg_temp.generation_patch('retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)',
 $old$or c.subscription_status is distinct from 'active'$old$,
 $new$or (c.subscription_status is distinct from 'active' and not(o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and c.subscription_status='trialing'))$new$);
select pg_temp.generation_patch('retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)',
 $old$ step_:=greatest(1,$old$,
 $new$ if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
  cutoff_:=(public.retail_generation_coverage(s,clock_)->>'billing_cutoff_at')::timestamptz;
  if cutoff_<=clock_ then return jsonb_build_object('status','held','code','notice_renewal_boundary_passed');end if;
 else
 step_:=greatest(1,$new$);
select pg_temp.generation_patch('retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text)',
 $old$ if step_>1000 then raise exception 'retail_renewal_notice_calendar_denied';end if;$old$,
 $new$ if step_>1000 then raise exception 'retail_renewal_notice_calendar_denied';end if;
 end if;$new$);

-- Pin new helpers and the adapted initial projection in the already-called
-- service/RLS schema guard, then refresh the SAME four transitive guards.
do $compile_consumers$
declare r record;
begin
 for r in select * from generation_patch_buffer order by signature loop execute r.definition;end loop;
 truncate generation_patch_buffer;
end $compile_consumers$;
select pg_temp.generation_patch('retail_existing_funding_schema_guard()',
 $old$declare t oid;$old$,$new$declare t oid;spec text[];m record;$new$);
do $new_dependencies$
declare entries text:='';spec text[];h text;
begin
 foreach spec slice 1 in array array[
  array['retail_generation_funding_valid(jsonb,jsonb)','i',''],
  array['retail_generation_coverage(jsonb,timestamptz)','v','lock'],
  array['retail_generation_calendar(jsonb)','i',''],array['retail_generation_prices_valid(jsonb,jsonb)','i',''],
  array['retail_admin_existing_billing_initial(jsonb,jsonb,jsonb,text,integer)','i','']
 ] loop
  select md5(prosrc) into h from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if h is null then raise exception 'retail_generation_funding_dependency_missing';end if;
  entries:=entries||case when entries='' then '' else ',' end||format('array[%L,%L,%L,%L]',spec[1],h,spec[2],spec[3]);
 end loop;
 perform pg_temp.generation_patch('retail_existing_funding_schema_guard()',E'begin\n if not exists',
  E'begin\n foreach spec slice 1 in array array['||entries||E'] loop\n'
  ||$new$  select * into m from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(m.prosrc) is distinct from spec[2] or m.prosecdef or m.proisstrict or m.provolatile::text<>spec[3]
   or m.proconfig is distinct from(case when spec[4]='lock' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',m.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
    where grantee not in(m.proowner,(select oid from pg_roles where rolname='service_role')))
   or(select count(*) from pg_proc q where q.pronamespace=m.pronamespace and q.proname=m.proname)<>1
   then raise exception 'retail_generation_funding_dependency_drift';end if;
 end loop;
 if not exists$new$);
end $new_dependencies$;
do $compile_schema_guard$
declare r record;
begin
 for r in select * from generation_patch_buffer order by signature loop execute r.definition;end loop;
 truncate generation_patch_buffer;
end $compile_schema_guard$;
do $fingerprints$
declare guard text;d text;r record;new_hash text;self_old text;self_new text;
begin
 foreach guard in array array['read_retail_existing_recurring_source(uuid,uuid)',
  'retail_admin_existing_billing_schema_guard()','retail_admin_existing_member_schema_guard()',
  'retail_linked_existing_member_schema_guard()'] loop
  select pg_get_functiondef(to_regprocedure('public.'||guard)) into d;
  for r in select * from generation_function_baseline loop
   if position(quote_literal(r.hash) in d)>0 then
    select md5(prosrc) into new_hash from pg_proc where oid=to_regprocedure('public.'||r.signature);
    if new_hash is null then raise exception 'retail_generation_fingerprint_dependency_missing';end if;
    d:=replace(d,quote_literal(r.hash),quote_literal(new_hash));
   end if;
  end loop;
  execute d;
  if guard='retail_linked_existing_member_schema_guard()' then
   select substring(prosrc from 'SELF_MD5:([a-f0-9]{32})'),
    md5(regexp_replace(prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
    into self_old,self_new from pg_proc where oid=to_regprocedure('public.'||guard);
   if self_old is null then raise exception 'retail_generation_self_fingerprint_missing';end if;
   execute replace(d,'SELF_MD5:'||self_old,'SELF_MD5:'||self_new);
  end if;
 end loop;
end $fingerprints$;
select public.retail_existing_funding_schema_guard();
select public.retail_admin_existing_billing_schema_guard();
select public.retail_admin_existing_member_schema_guard();
select public.retail_linked_existing_member_schema_guard();
drop function pg_temp.generation_patch(text,text,text);
commit;
