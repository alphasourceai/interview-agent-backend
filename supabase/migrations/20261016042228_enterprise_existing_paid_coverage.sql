-- LOCAL/UNMOUNTED paid-prefix read and base billing-status refresh.
-- No legal term advancement, renewal preference, provider or account effects.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace
  and proname in('read_enterprise_existing_paid_coverage','refresh_enterprise_existing_paid_coverage'))
  then raise exception 'enterprise_coverage_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',true,'plpgsql','v','jsonb'),
  ('enterprise_existing_billing_context(public.membership_agreements)','fb36dd4af607965a442a1e4fa73017b5',false,'plpgsql','v','void'),
  ('enterprise_existing_paid_agreement_valid(public.membership_agreements)','c46a3752ad53dacc38ed6df1a6fd8f8c',false,'plpgsql','i','boolean'),
  ('enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools)','6a7844c82a1a47bf277a017f9269d21a',false,'sql','i','boolean'),
  ('enterprise_existing_period_proof_valid(jsonb,public.membership_agreements)','fcbb9b7ba46a9ba44fcbf7b49bcf17b0',false,'plpgsql','i','boolean'),
  ('enterprise_existing_period_receipt_guard()','5db018f211c3dbafeee90e176b5eeab1',false,'plpgsql','v','trigger'),
  ('record_enterprise_existing_paid_period(uuid,uuid,jsonb,jsonb)','d784e472c99fc2682a86afbbcd193db1',true,'plpgsql','v','jsonb')
 )v(signature,hash,bounded,language,volatility,result_type) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.prolang is distinct from(select oid from pg_language where lanname=r.language)
   or p.provolatile::text is distinct from r.volatility or p.prorettype is distinct from r.result_type::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.bounded then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_coverage_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_attribute where attrelid='public.billing_invoices'::regclass
  and attname='enterprise_period_receipt' and atttypid='jsonb'::regtype and not attisdropped)
  or not exists(select 1 from pg_trigger where tgrelid='public.billing_invoices'::regclass
   and tgname='enterprise_existing_period_receipt_guard' and tgenabled='O' and tgtype=31
   and tgfoid='public.enterprise_existing_period_receipt_guard()'::regprocedure)
  or not exists(select 1 from pg_class where oid='public.billing_invoices'::regclass and relrowsecurity)
  then raise exception 'enterprise_coverage_table_drift';end if;
end $baseline$;

create function public.read_enterprise_existing_paid_coverage(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;a public.membership_agreements;pool public.client_interview_pools;b public.billing_customers;
 r record;w jsonb;receipt jsonb;proof jsonb;clock timestamptz;cash_at timestamptz;until_at timestamptz;prefix integer:=0;n integer;
 seen_lines text[]:='{}';seen_pi text[]:='{}';seen_ch text[]:='{}';seen_ord integer[]:='{}';
begin
 if current_user<>'service_role' then raise exception 'enterprise_coverage_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found or c.parent_client_id is not null or c.archived_at is not null then raise exception 'enterprise_coverage_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.voided_at is not null then raise exception 'enterprise_coverage_source_denied';end if;
 select * into pool from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_coverage_pool_denied';end if;
 select * into strict b from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 if b.client_id is distinct from c.id then raise exception 'enterprise_coverage_owner_denied';end if;
 w:=public.read_enterprise_existing_billing(a.id);
 if w is null or not coalesce(public.enterprise_existing_paid_agreement_valid(a),false)
  or not coalesce(public.enterprise_existing_paid_pool_valid(a,pool),false)
  then raise exception 'enterprise_coverage_source_denied';end if;
 perform 1 from public.billing_invoices where enterprise_period_receipt->'proof'->>'agreement_id'=a.id::text order by id for share;
 clock:=clock_timestamp();cash_at:=(w->'funding_receipt'->'proof'->>'payment_success_at')::timestamptz;
 until_at:=to_timestamp((w->'subscription'->>'current_period_end')::bigint);
 if cash_at>clock or until_at<=cash_at or(select count(*) from public.billing_invoices
  where enterprise_period_receipt->'proof'->>'agreement_id'=a.id::text)>999 then raise exception 'enterprise_coverage_clock_or_census_denied';end if;
 for r in select * from public.billing_invoices where enterprise_period_receipt->'proof'->>'agreement_id'=a.id::text
  order by (enterprise_period_receipt->'proof'->>'ordinal')::integer loop
  receipt:=r.enterprise_period_receipt;proof:=receipt->'proof';
  if not coalesce(public.retail_existing_closed_object(receipt,array['version','source','source_digest','proof','recorded_at']),false)
   or receipt->>'version' is distinct from 'enterprise_existing_paid_period_receipt_v1'
   or receipt->'source' is distinct from w or receipt->>'source_digest' is distinct from md5(w::text)
   or not coalesce(public.enterprise_existing_period_proof_valid(proof,a),false)
   or r.billing_customer_id is distinct from b.id or r.stripe_invoice_id is distinct from proof->>'invoice_id'
   or r.amount_total_cents is distinct from(proof->>'cash_cents')::integer or r.currency is distinct from 'usd'
   or jsonb_typeof(receipt->'recorded_at') is distinct from 'string'
   or receipt->>'recorded_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
   or not isfinite((receipt->>'recorded_at')::timestamptz) or(receipt->>'recorded_at')::timestamptz>clock
   or(receipt->>'recorded_at')::timestamptz<(proof->>'paid_at')::timestamptz
   or(proof->>'paid_at')::timestamptz>clock
   or proof->>'line_id'=any(seen_lines) or proof->>'payment_intent_id'=any(seen_pi) or proof->>'charge_id'=any(seen_ch)
   then raise exception 'enterprise_coverage_receipt_denied';end if;
  seen_lines:=array_append(seen_lines,proof->>'line_id');seen_pi:=array_append(seen_pi,proof->>'payment_intent_id');seen_ch:=array_append(seen_ch,proof->>'charge_id');
  n:=(proof->>'ordinal')::integer;
  if n=any(seen_ord) then raise exception 'enterprise_coverage_ordinal_denied';end if;
  seen_ord:=array_append(seen_ord,n);
  if n=prefix+1 then prefix:=n;until_at:=to_timestamp((proof->>'provider_period_end')::bigint);end if;
 end loop;
 return jsonb_build_object('version','enterprise_existing_paid_coverage_v1','agreement_id',a.id,'client_id',c.id,
  'billing_source_digest',md5(w::text),'contiguous_ordinal',prefix,
  'funded_from',to_char(cash_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'funded_through',to_char(until_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'observed_at',to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);
end $$;

create function public.refresh_enterprise_existing_paid_coverage(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;coverage jsonb;clock timestamptz;status text;
begin
 if current_user<>'service_role' then raise exception 'enterprise_coverage_server_only';end if;
 coverage:=public.read_enterprise_existing_paid_coverage(p_agreement,p_client);
 -- All source, invoice and root locks from the nested read are retained in
 -- this transaction. No caller clock or provider status extends this prefix.
 select * into strict c from public.clients where id=p_client;
 clock:=clock_timestamp();status:=case when clock>=(coverage->>'funded_from')::timestamptz
  and clock<(coverage->>'funded_through')::timestamptz then 'active' else 'inactive' end;
 if c.manual_active_override is true then return coverage||jsonb_build_object('status','manual_override','computed_billing_status',status);end if;
 update public.clients set billing_status=status where id=c.id;
 return coverage||jsonb_build_object('status','refreshed','billing_status',status);
end $$;
revoke all on function public.read_enterprise_existing_paid_coverage(uuid,uuid),public.refresh_enterprise_existing_paid_coverage(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_enterprise_existing_paid_coverage(uuid,uuid),public.refresh_enterprise_existing_paid_coverage(uuid,uuid) to service_role;
commit;
