-- LOCAL/UNMOUNTED. Original frozen billing receipt -> existing invoice row.
-- No collection, pool, plan, access, payroll, Auth or delivery effect.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 if exists(select 1 from pg_attribute where attrelid='public.billing_invoices'::regclass
  and attname='enterprise_period_receipt' and not attisdropped)
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in
   ('enterprise_existing_period_proof_valid','enterprise_existing_period_receipt_guard','record_enterprise_existing_paid_period'))
  then raise exception 'enterprise_period_schema_drift';end if;
 for r in select * from(values
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808',false,'plpgsql','v','jsonb',false),
  ('enterprise_existing_billing_context(public.membership_agreements)','fb36dd4af607965a442a1e4fa73017b5',false,'plpgsql','v','void',false),
  ('enterprise_existing_paid_agreement_valid(public.membership_agreements)','c46a3752ad53dacc38ed6df1a6fd8f8c',false,'plpgsql','i','boolean',false),
  ('enterprise_existing_paid_pool_valid(public.membership_agreements,public.client_interview_pools)','6a7844c82a1a47bf277a017f9269d21a',false,'sql','i','boolean',false),
  ('retail_existing_month_anchor(timestamptz,integer)','215a4af8ed5457b66f11e6234f7f5741',true,'plpgsql','i','timestamptz',true),
  ('retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60',false,'sql','i','boolean',false)
 )v(signature,hash,retail,language,volatility,result_type,strict_flag) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset
   or p.prolang is distinct from(select oid from pg_language where lanname=r.language)
   or p.provolatile::text is distinct from r.volatility or p.prorettype is distinct from r.result_type::regtype
   or p.proisstrict is distinct from r.strict_flag
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.retail then array['search_path=pg_catalog, public']
    when r.signature like 'read_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_period_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.billing_invoices'::regclass and relrowsecurity)
  or not has_table_privilege('service_role','public.billing_invoices','SELECT,INSERT,UPDATE')
  or not exists(select 1 from pg_index where indexrelid=to_regclass('public.billing_invoices_stripe_invoice_id_uniq')
   and indrelid='public.billing_invoices'::regclass and indisunique and indisvalid and indisready and indislive and indimmediate
   and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX billing_invoices_stripe_invoice_id_uniq ON public.billing_invoices USING btree (stripe_invoice_id) WHERE (stripe_invoice_id IS NOT NULL)')
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='enterprise_existing_billing_guard' and tgenabled='O' and tgtype=31
   and tgfoid='public.enterprise_existing_billing_guard()'::regprocedure)
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='enterprise_existing_billing_commit_guard' and tgenabled='O' and tgtype=17 and tgdeferrable and tginitdeferred
   and tgfoid='public.enterprise_existing_billing_commit_guard()'::regprocedure)
  then raise exception 'enterprise_period_table_drift';end if;
end $baseline$;
alter table public.billing_invoices add column enterprise_period_receipt jsonb;

create function public.enterprise_existing_period_proof_valid(p jsonb,a public.membership_agreements)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare f jsonb:=a.enterprise_funding_receipt->'proof';w jsonb:=a.enterprise_billing_receipt;k text;
 n integer;span integer;b timestamptz;paid timestamptz;gross bigint;discount bigint;net bigint;tax bigint;cash bigint;
begin
 if not coalesce(public.retail_existing_closed_object(p,array['version','agreement_id','client_id','provider_account_id','livemode','currency',
  'invoice_id','line_id','subscription_id','subscription_item_id','customer_id','price_id','ordinal','provider_period_start','provider_period_end',
  'platform_gross_cents','platform_discount_cents','platform_net_cents','tax_cents','cash_cents','original_paid_at','paid_at',
  'payment_intent_id','charge_id','provider_effect_authorized','paid_access_authorized','payroll_authorized']),false)
  or p->>'version' is distinct from 'enterprise_existing_platform_period_proof_v1'
  or not coalesce(public.enterprise_existing_paid_agreement_valid(a),false)
  or p->>'agreement_id' is distinct from a.id::text or p->>'client_id' is distinct from a.client_id::text
  or p->>'currency' is distinct from 'usd' or p->'original_paid_at' is distinct from f->'payment_success_at'
  or p->'provider_account_id' is distinct from f->'provider_account_id' or p->'livemode' is distinct from f->'livemode'
  or p->'customer_id' is distinct from f->'customer_id' or p->'subscription_id' is distinct from f->'subscription_id'
  or p->'price_id' is distinct from f->'platform_price_id' or p->'subscription_item_id' is distinct from f->'platform_item_id'
  or p->'provider_effect_authorized' is distinct from 'false'::jsonb
  or p->'paid_access_authorized' is distinct from 'false'::jsonb or p->'payroll_authorized' is distinct from 'false'::jsonb
  then return false;end if;
 foreach k in array array['invoice_id','line_id','payment_intent_id','charge_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>255
   or p->>k !~ ((case k when 'invoice_id' then '^in_' when 'line_id' then '^il_' when 'payment_intent_id' then '^pi_' else '^ch_' end)||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 if p->'invoice_id'=f->'invoice_id' or p->'line_id'=f->'pool_line_id'
  or p->'payment_intent_id'=f->'payment_intent_id' or p->'charge_id'=f->'charge_id' then return false;end if;
 foreach k in array array['ordinal','provider_period_start','provider_period_end','platform_gross_cents',
  'platform_discount_cents','platform_net_cents','tax_cents','cash_cents'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$'
   or(p->>k)::numeric>9007199254740991 then return false;end if;
 end loop;
 if jsonb_typeof(p->'paid_at') is distinct from 'string'
  or p->>'paid_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$'
  then return false;end if;
 n:=(p->>'ordinal')::integer;span:=case f->>'platform_interval' when 'month' then 1 when 'year' then 12 else 0 end;
 paid:=(p->>'paid_at')::timestamptz;b:=to_timestamp((w->'subscription'->>'current_period_end')::bigint);
 if n not between 1 and 999 or span=0 or not isfinite(paid) or paid<(f->>'payment_success_at')::timestamptz
  or extract(epoch from public.retail_existing_month_anchor(b,(n-1)*span))<>(p->>'provider_period_start')::bigint
  or extract(epoch from public.retail_existing_month_anchor(b,n*span))<>(p->>'provider_period_end')::bigint
  then return false;end if;
 foreach k in array array['platform_gross_cents','platform_discount_cents','platform_net_cents','tax_cents','cash_cents'] loop
  if(p->>k)::numeric>2147483647 then return false;end if;
 end loop;
 gross:=(p->>'platform_gross_cents')::bigint;discount:=(p->>'platform_discount_cents')::bigint;
 net:=(p->>'platform_net_cents')::bigint;tax:=(p->>'tax_cents')::bigint;cash:=(p->>'cash_cents')::bigint;
 return gross>0 and net>0 and cash>0 and gross=(f->>'platform_nominal_cents')::bigint
  and net=gross-discount and cash=net+tax;
exception when others then return false;
end $$;

create function public.enterprise_existing_period_receipt_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare w jsonb;a public.membership_agreements;clock timestamptz;
begin
 if TG_OP='DELETE' then
  if old.enterprise_period_receipt is not null then raise exception 'enterprise_period_receipt_immutable';end if;return old;
 end if;
 if TG_OP='INSERT' then
  if new.enterprise_period_receipt is not null then raise exception 'enterprise_period_writer_required';end if;return new;
 end if;
 if old.enterprise_period_receipt is not null then
  if new.enterprise_period_receipt is distinct from old.enterprise_period_receipt or new.billing_customer_id is distinct from old.billing_customer_id
   or new.stripe_invoice_id is distinct from old.stripe_invoice_id or new.amount_total_cents is distinct from old.amount_total_cents
   or new.currency is distinct from old.currency then raise exception 'enterprise_period_receipt_immutable';end if;return new;
 end if;
 if new.enterprise_period_receipt is null then return new;end if;
 w:=new.enterprise_period_receipt;clock:=clock_timestamp();
 if current_user<>'service_role' or current_setting('private_sales.enterprise_period_writer',true) is distinct from new.id::text
  or not coalesce(public.retail_existing_closed_object(w,array['version','source','source_digest','proof','recorded_at']),false)
  or w->>'version' is distinct from 'enterprise_existing_paid_period_receipt_v1'
  or w->>'source_digest' is distinct from md5((w->'source')::text) or w->'recorded_at' is distinct from 'null'::jsonb
  then raise exception 'enterprise_period_writer_required';end if;
 select * into a from public.membership_agreements where id=(w->'proof'->>'agreement_id')::uuid;
 if not found or a.enterprise_billing_receipt is distinct from w->'source'
  or not coalesce(public.enterprise_existing_period_proof_valid(w->'proof',a),false)
  or new.stripe_invoice_id is distinct from w->'proof'->>'invoice_id'
  or new.amount_total_cents is distinct from(w->'proof'->>'cash_cents')::integer or new.currency is distinct from 'usd'
  or new.retail_period_receipt is not null
  or not exists(select 1 from public.billing_customers where id=new.billing_customer_id and client_id=a.client_id
   and stripe_customer_id=w->'proof'->>'customer_id')
  or(w->'proof'->>'paid_at')::timestamptz>clock then raise exception 'enterprise_period_writer_required';end if;
 new.enterprise_period_receipt:=jsonb_set(w,'{recorded_at}',to_jsonb(to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 return new;
end $$;
create trigger enterprise_existing_period_receipt_guard before insert or update or delete on public.billing_invoices
 for each row execute function public.enterprise_existing_period_receipt_guard();
create unique index enterprise_existing_paid_period_ordinal_key on public.billing_invoices
 ((enterprise_period_receipt->'proof'->>'agreement_id'),((enterprise_period_receipt->'proof'->>'ordinal')::integer)) where enterprise_period_receipt is not null;
create unique index enterprise_existing_paid_period_line_key on public.billing_invoices
 ((enterprise_period_receipt->'proof'->>'provider_account_id'),(enterprise_period_receipt->'proof'->>'livemode'),
 (enterprise_period_receipt->'proof'->>'line_id')) where enterprise_period_receipt is not null;
create unique index enterprise_existing_paid_period_pi_key on public.billing_invoices
 ((enterprise_period_receipt->'proof'->>'provider_account_id'),(enterprise_period_receipt->'proof'->>'livemode'),
 (enterprise_period_receipt->'proof'->>'payment_intent_id')) where enterprise_period_receipt is not null;
create unique index enterprise_existing_paid_period_charge_key on public.billing_invoices
 ((enterprise_period_receipt->'proof'->>'provider_account_id'),(enterprise_period_receipt->'proof'->>'livemode'),
 (enterprise_period_receipt->'proof'->>'charge_id')) where enterprise_period_receipt is not null;

create function public.record_enterprise_existing_paid_period(p_agreement uuid,p_client uuid,p_billing jsonb,p_proof jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;pool public.client_interview_pools;owner public.billing_customers;
 v public.billing_invoices;w jsonb;receipt jsonb;clock timestamptz;
begin
 if current_user<>'service_role' then raise exception 'enterprise_period_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found or c.parent_client_id is not null or c.archived_at is not null then raise exception 'enterprise_period_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.voided_at is not null then raise exception 'enterprise_period_source_denied';end if;
 select * into pool from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_period_pool_denied';end if;
 select * into strict owner from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 if owner.client_id is distinct from c.id then raise exception 'enterprise_period_owner_denied';end if;
 perform public.enterprise_existing_billing_context(a);w:=public.read_enterprise_existing_billing(a.id);
 if w is null or w is distinct from p_billing or not coalesce(public.enterprise_existing_paid_agreement_valid(a),false)
  or not coalesce(public.enterprise_existing_paid_pool_valid(a,pool),false)
  or not coalesce(public.enterprise_existing_period_proof_valid(p_proof,a),false)
  then raise exception 'enterprise_period_source_denied';end if;
 perform 1 from public.billing_invoices where stripe_invoice_id=p_proof->>'invoice_id'
  or(enterprise_period_receipt->'proof'->>'agreement_id'=a.id::text
   and enterprise_period_receipt->'proof'->>'ordinal'=p_proof->>'ordinal') order by id for update;
 select * into v from public.billing_invoices where stripe_invoice_id=p_proof->>'invoice_id';
 if found and(v.billing_customer_id is distinct from owner.id or v.retail_period_receipt is not null)
  then raise exception 'enterprise_period_invoice_owner_conflict';end if;
 -- This census is structural server attestation, not a shared cross-writer
 -- reservation. Other clients' unrelated writers do not take our root lock.
 if exists(select 1 from public.membership_agreements x where x.enterprise_funding_receipt is not null
  and x.enterprise_funding_receipt->'proof'->'provider_account_id'=p_proof->'provider_account_id'
  and x.enterprise_funding_receipt->'proof'->'livemode'=p_proof->'livemode'
  and(x.enterprise_funding_receipt->'proof'->'invoice_id'=p_proof->'invoice_id'
   or x.enterprise_funding_receipt->'proof'->'pool_line_id'=p_proof->'line_id'
   or x.enterprise_funding_receipt->'proof'->'payment_intent_id'=p_proof->'payment_intent_id'
   or x.enterprise_funding_receipt->'proof'->'charge_id'=p_proof->'charge_id'))
  or exists(select 1 from public.membership_agreements x where x.retail_funding_receipt is not null
   and x.retail_funding_receipt->'proof'->'provider_account_id'=p_proof->'provider_account_id'
   and x.retail_funding_receipt->'proof'->'period'->'livemode'=p_proof->'livemode'
   and(x.retail_funding_receipt->'proof'->'period'->'invoice_id'=p_proof->'invoice_id'
    or x.retail_funding_receipt->'proof'->'period'->'platform_invoice_line_id'=p_proof->'line_id'
    or x.retail_funding_receipt->'proof'->'payment_intent_id'=p_proof->'payment_intent_id'
    or x.retail_funding_receipt->'proof'->'charge_id'=p_proof->'charge_id'))
  or exists(select 1 from public.billing_invoices x where x.retail_period_receipt is not null
   and x.retail_period_receipt->'proof'->'provider_account_id'=p_proof->'provider_account_id'
   and x.retail_period_receipt->'proof'->'livemode'=p_proof->'livemode'
   and(x.retail_period_receipt->'proof'->'invoice_id'=p_proof->'invoice_id'
    or x.retail_period_receipt->'proof'->'line_id'=p_proof->'line_id'
    or x.retail_period_receipt->'proof'->'payment_intent_id'=p_proof->'payment_intent_id'
    or x.retail_period_receipt->'proof'->'charge_id'=p_proof->'charge_id'))
  or exists(select 1 from public.usage_billing_ledger x where x.stripe_invoice_id=p_proof->>'invoice_id'
   or x.stripe_invoice_item_id=p_proof->>'line_id') then raise exception 'enterprise_period_cash_identity_conflict';end if;
 if to_regclass('public.enterprise_existing_usage_batches') is not null then
  if exists(select 1 from public.enterprise_existing_usage_batches x where x.account_id=p_proof->>'provider_account_id'
   and to_jsonb(x.livemode)=p_proof->'livemode' and(to_jsonb(x)->'provider_operation'->>'invoice_id'=p_proof->>'invoice_id'
    or to_jsonb(x)->'provider_operation'->'operations'->'pay'->'proof'->'payment_intent_id'=p_proof->'payment_intent_id'
    or to_jsonb(x)->'provider_operation'->'operations'->'pay'->'proof'->'charge_id'=p_proof->'charge_id'))
   then raise exception 'enterprise_period_usage_identity_conflict';end if;
 end if;
 if v.enterprise_period_receipt is not null then
  receipt:=v.enterprise_period_receipt;
  if receipt->'source' is distinct from w or receipt->'proof' is distinct from p_proof
   then raise exception 'enterprise_period_replay_conflict';end if;
  return jsonb_build_object('status','already_recorded','invoice_id',v.id,'receipt',receipt);
 end if;
 if exists(select 1 from public.billing_invoices where enterprise_period_receipt->'proof'->>'agreement_id'=a.id::text
  and enterprise_period_receipt->'proof'->>'ordinal'=p_proof->>'ordinal') then raise exception 'enterprise_period_ordinal_conflict';end if;
 if v.id is null then
  insert into public.billing_invoices(billing_customer_id,invoice_title,title,amount_total_cents,currency,status,stripe_invoice_id,customer_name,customer_email)
  values(owner.id,'alphaScreen membership payment','alphaScreen membership payment',(p_proof->>'cash_cents')::integer,
   'usd','paid',p_proof->>'invoice_id',c.name,c.email) returning * into v;
 elsif v.amount_total_cents is distinct from(p_proof->>'cash_cents')::integer or v.currency is distinct from 'usd'
  then raise exception 'enterprise_period_invoice_amount_conflict';end if;
 -- All waits ended. Original source is still immutable and paid, not a new
 -- activation; native time cannot be supplied by caller or proof.
 clock:=clock_timestamp();
 if public.read_enterprise_existing_billing(a.id) is distinct from w or(p_proof->>'paid_at')::timestamptz>clock
  then raise exception 'enterprise_period_clock_or_source_denied';end if;
 receipt:=jsonb_build_object('version','enterprise_existing_paid_period_receipt_v1','source',w,'source_digest',md5(w::text),
  'proof',p_proof,'recorded_at',null);
 perform set_config('private_sales.enterprise_period_writer',v.id::text,true);
 update public.billing_invoices set enterprise_period_receipt=receipt,status='paid' where id=v.id returning enterprise_period_receipt into receipt;
 perform set_config('private_sales.enterprise_period_writer','',true);
 return jsonb_build_object('status','recorded','invoice_id',v.id,'receipt',receipt);
end $$;
revoke all on function public.enterprise_existing_period_proof_valid(jsonb,public.membership_agreements),
 public.enterprise_existing_period_receipt_guard(),public.record_enterprise_existing_paid_period(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enterprise_existing_period_proof_valid(jsonb,public.membership_agreements),
 public.enterprise_existing_period_receipt_guard(),public.record_enterprise_existing_paid_period(uuid,uuid,jsonb,jsonb) to service_role;
commit;
