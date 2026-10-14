-- Additive, LOCAL ONLY until exact-source/native release review. Uses the
-- existing invoice/customer/client tables; no provider or Auth operation.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_attribute where attrelid='public.billing_invoices'::regclass
  and attname='retail_period_receipt' and not attisdropped)
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace
   and proname in('retail_existing_period_proof_valid','retail_existing_period_receipt_guard',
    'record_retail_existing_paid_period','refresh_retail_existing_paid_coverage'))
  then raise exception 'retail_period_schema_drift';end if;
 if not exists(select 1 from pg_index where indrelid='public.billing_invoices'::regclass
  and indisunique and indisvalid and indisready and indislive and indimmediate
  and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX billing_invoices_stripe_invoice_id_uniq ON public.billing_invoices USING btree (stripe_invoice_id) WHERE (stripe_invoice_id IS NOT NULL)')
  then raise exception 'retail_period_invoice_index_drift';end if;
 perform public.retail_existing_funding_schema_guard();
end $baseline$;
alter table public.billing_invoices add column retail_period_receipt jsonb;

create function public.retail_existing_period_proof_valid(p jsonb,s jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare o jsonb:=s->'package_snapshot'->'membership_terms';b jsonb:=s->'original_period';
 k text;n integer;span integer;start_b timestamptz;start_a timestamptz;paid timestamptz;
 gross bigint;discount bigint;net bigint;tax bigint;cash bigint;
begin
 if not coalesce(public.retail_existing_closed_object(p,array['version','agreement_id','client_id','offer_version',
  'provider_account_id','livemode','currency','ordinal','invoice_id','line_id','price_id','subscription_id','subscription_item_id',
  'customer_id','original_paid_at','paid_at','invoice_created','provider_period_start','provider_period_end',
  'platform_gross_cents','platform_discount_cents','platform_net_cents','tax_cents','cash_cents','payment_intent_id','charge_id']),false)
  or p->>'version' is distinct from 'retail_existing_recurring_funding_proof_v1'
  or s->>'version' is distinct from 'retail_existing_recurring_source_v1'
  or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'
  or not coalesce(public.retail_existing_valid_offer(o),false)
  or s->'package_snapshot' is distinct from public.retail_existing_package(o)
  or p->'agreement_id' is distinct from s->'agreement_id' or p->'client_id' is distinct from s->'client_id'
  or p->'offer_version' is distinct from o->'offer_version'
  or p->'provider_account_id' is distinct from s->'original_provider_account_id'
  or p->'livemode' is distinct from b->'livemode' or p->>'currency' is distinct from 'usd'
  or p->'original_paid_at' is distinct from b->'paid_at'
  then return false;end if;
 foreach k in array array['price_id','subscription_id','subscription_item_id','customer_id'] loop
  if p->k is distinct from b->k then return false;end if;
 end loop;
 foreach k in array array['invoice_id','line_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>255
   or p->>k !~ (case k when 'invoice_id' then '^in_' else '^il_' end||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 if p->'invoice_id' is not distinct from b->'invoice_id' or p->'line_id' is not distinct from b->'platform_invoice_line_id'
  then return false;end if;
 foreach k in array array['ordinal','invoice_created','provider_period_start','provider_period_end',
  'platform_gross_cents','platform_discount_cents','platform_net_cents','tax_cents','cash_cents'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$'
   or(p->>k)::numeric>9007199254740991 then return false;end if;
 end loop;
 if jsonb_typeof(p->'paid_at') is distinct from 'string'
  or p->>'paid_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$'
  then return false;end if;
 n:=(p->>'ordinal')::integer;span:=(o->'stripe_recurrence'->>'interval_count')::integer;
 start_b:=to_timestamp((b->>'provider_period_start')::bigint);start_a:=(b->>'paid_at')::timestamptz;paid:=(p->>'paid_at')::timestamptz;
 if n<1 or n>999 or not isfinite(paid) or paid<start_a
  or extract(epoch from public.retail_existing_month_anchor(start_b,span))<>(b->>'provider_period_end')::bigint
  or extract(epoch from public.retail_existing_month_anchor(start_b,n*span))<>(p->>'provider_period_start')::bigint
  or extract(epoch from public.retail_existing_month_anchor(start_b,(n+1)*span))<>(p->>'provider_period_end')::bigint
  or(p->>'invoice_created')::bigint<(p->>'provider_period_start')::bigint
  or(p->>'invoice_created')::bigint>extract(epoch from paid)
  then return false;end if;
 gross:=(p->>'platform_gross_cents')::bigint;discount:=(p->>'platform_discount_cents')::bigint;
 net:=(p->>'platform_net_cents')::bigint;tax:=(p->>'tax_cents')::bigint;cash:=(p->>'cash_cents')::bigint;
 if gross<>(o->>'platform_payment_cents')::bigint or discount>gross or net<>gross-discount
  or cash<>net+tax or cash>2147483647 then return false;end if;
 if cash=0 then return discount=gross and tax=0 and p->'payment_intent_id'='null'::jsonb and p->'charge_id'='null'::jsonb;end if;
 foreach k in array array['payment_intent_id','charge_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>255
   or p->>k !~ (case k when 'payment_intent_id' then '^pi_' else '^ch_' end||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.retail_existing_period_receipt_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare w jsonb;clock timestamptz;
begin
 if TG_OP='DELETE' then
  if old.retail_period_receipt is not null then raise exception 'retail_period_receipt_immutable';end if;return old;
 end if;
 if TG_OP='INSERT' then
  if new.retail_period_receipt is not null then raise exception 'retail_period_record_required';end if;return new;
 end if;
 if old.retail_period_receipt is not null then
  if new.retail_period_receipt is distinct from old.retail_period_receipt
   or new.billing_customer_id is distinct from old.billing_customer_id
   or new.stripe_invoice_id is distinct from old.stripe_invoice_id
   then raise exception 'retail_period_receipt_immutable';end if;return new;
 end if;
 if new.retail_period_receipt is null then return new;end if;
 w:=new.retail_period_receipt;clock:=clock_timestamp();
 if current_user<>'service_role' or current_setting('private_sales.retail_period_writer',true) is distinct from new.id::text
  or not coalesce(public.retail_existing_closed_object(w,array['version','source','source_digest','proof','recorded_at']),false)
  or w->>'version' is distinct from 'retail_existing_paid_period_receipt_v1'
  or w->>'source_digest' is distinct from md5((w->'source')::text)
  or not coalesce(public.retail_existing_period_proof_valid(w->'proof',w->'source'),false)
  or new.stripe_invoice_id is distinct from w->'proof'->>'invoice_id'
  or(w->'proof'->>'paid_at')::timestamptz>clock or w->'recorded_at' is distinct from 'null'::jsonb
  then raise exception 'retail_period_record_required';end if;
 new.retail_period_receipt:=jsonb_set(w,'{recorded_at}',to_jsonb(to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 return new;
end $$;
create trigger retail_existing_period_receipt_guard before insert or update or delete on public.billing_invoices
 for each row execute function public.retail_existing_period_receipt_guard();
create unique index retail_existing_paid_period_ordinal_key on public.billing_invoices
 ((retail_period_receipt->'proof'->>'agreement_id'),((retail_period_receipt->'proof'->>'ordinal')::integer)) where retail_period_receipt is not null;
create unique index retail_existing_paid_period_line_key on public.billing_invoices
 ((retail_period_receipt->'proof'->>'provider_account_id'),(retail_period_receipt->'proof'->>'livemode'),
 (retail_period_receipt->'proof'->>'line_id')) where retail_period_receipt is not null;
create unique index retail_existing_paid_period_pi_key on public.billing_invoices
 ((retail_period_receipt->'proof'->>'provider_account_id'),(retail_period_receipt->'proof'->>'livemode'),
 (retail_period_receipt->'proof'->>'payment_intent_id')) where retail_period_receipt is not null
 and retail_period_receipt->'proof'->'payment_intent_id'<>'null'::jsonb;
create unique index retail_existing_paid_period_charge_key on public.billing_invoices
 ((retail_period_receipt->'proof'->>'provider_account_id'),(retail_period_receipt->'proof'->>'livemode'),
 (retail_period_receipt->'proof'->>'charge_id')) where retail_period_receipt is not null
 and retail_period_receipt->'proof'->'charge_id'<>'null'::jsonb;

create function public.record_retail_existing_paid_period(p_agreement uuid,p_client uuid,p_source jsonb,p_proof jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;b public.billing_customers;v public.billing_invoices;
 s jsonb;w jsonb;o jsonb;clock timestamptz;
begin
 if current_user<>'service_role' then raise exception 'retail_period_server_only';end if;
 perform 1 from public.public_purchase_intents where agreement_id=p_agreement order by id for update;
 select * into a from public.membership_agreements where id=p_agreement for update;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 s:=public.read_retail_existing_recurring_source(p_agreement,p_client);o:=s->'package_snapshot'->'membership_terms';
 if s is distinct from p_source or not coalesce(public.retail_existing_period_proof_valid(p_proof,s),false)
  or c.plan_tier is distinct from o->>'plan_key'
  or c.billing_interval is distinct from(case o->>'payment_option' when 'prepaid' then 'prepaid' else 'monthly' end)
  then raise exception 'retail_period_source_denied';end if;
 select * into strict b from public.billing_customers where client_id=c.id and stripe_customer_id=c.stripe_customer_id;
 perform 1 from public.billing_invoices where stripe_invoice_id=p_proof->>'invoice_id'
  or(retail_period_receipt->'proof'->>'agreement_id'=p_agreement::text
   and retail_period_receipt->'proof'->>'ordinal'=p_proof->>'ordinal') order by id for update;
 select * into v from public.billing_invoices where stripe_invoice_id=p_proof->>'invoice_id';
 if found and v.billing_customer_id is distinct from b.id then raise exception 'retail_period_owner_conflict';end if;
 if v.retail_period_receipt is not null then
  w:=v.retail_period_receipt;
  if w->'source' is distinct from s or w->'proof' is distinct from p_proof then raise exception 'retail_period_replay_conflict';end if;
  return jsonb_build_object('status','already_recorded','invoice_id',v.id,'receipt',w);
 end if;
 if exists(select 1 from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=p_agreement::text
  and retail_period_receipt->'proof'->>'ordinal'=p_proof->>'ordinal') then raise exception 'retail_period_ordinal_conflict';end if;
 if exists(select 1 from public.membership_agreements x where x.retail_funding_receipt is not null
  and x.retail_funding_receipt->'proof'->'provider_account_id'=p_proof->'provider_account_id'
  and x.retail_funding_receipt->'proof'->'period'->'livemode'=p_proof->'livemode'
  and(x.retail_funding_receipt->'proof'->'period'->'invoice_id'=p_proof->'invoice_id'
   or x.retail_funding_receipt->'proof'->'period'->'platform_invoice_line_id'=p_proof->'line_id'
   or(p_proof->'payment_intent_id'<>'null'::jsonb and x.retail_funding_receipt->'proof'->'payment_intent_id'=p_proof->'payment_intent_id')
   or(p_proof->'charge_id'<>'null'::jsonb and x.retail_funding_receipt->'proof'->'charge_id'=p_proof->'charge_id')))
  then raise exception 'retail_period_initial_identity_conflict';end if;
 if v.id is null then
  insert into public.billing_invoices(billing_customer_id,invoice_title,title,amount_total_cents,currency,status,stripe_invoice_id,customer_name,customer_email)
  values(b.id,'alphaScreen membership payment','alphaScreen membership payment',(p_proof->>'cash_cents')::integer,
   'usd','paid',p_proof->>'invoice_id',c.name,c.email) returning * into v;
 end if;
 -- The invoice-row wait has ended. Revalidate native source and paid clock
 -- immediately before recording. No authentication claim/lease is revived.
 s:=public.read_retail_existing_recurring_source(p_agreement,p_client);clock:=clock_timestamp();
 if s is distinct from p_source or(p_proof->>'paid_at')::timestamptz>clock then raise exception 'retail_period_clock_or_source_denied';end if;
 w:=jsonb_build_object('version','retail_existing_paid_period_receipt_v1','source',s,'source_digest',md5(s::text),'proof',p_proof,'recorded_at',null);
 perform set_config('private_sales.retail_period_writer',v.id::text,true);
 update public.billing_invoices set retail_period_receipt=w where id=v.id returning retail_period_receipt into w;
 perform set_config('private_sales.retail_period_writer','',true);
 return jsonb_build_object('status','recorded','invoice_id',v.id,'receipt',w);
end $$;

create function public.refresh_retail_existing_paid_coverage(p_agreement uuid,p_client uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;s jsonb;o jsonb;w jsonb;r record;clock timestamptz;a timestamptz;until_at timestamptz;
 term_start timestamptz;term_end timestamptz;old_start timestamptz;old_end timestamptz;
 prefix integer:=0;n integer;span integer;months integer;term_index integer;funded_term integer;status text;
begin
 if current_user<>'service_role' then raise exception 'retail_period_server_only';end if;
 perform 1 from public.public_purchase_intents where agreement_id=p_agreement order by id for update;
 perform 1 from public.membership_agreements where id=p_agreement for update;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 s:=public.read_retail_existing_recurring_source(p_agreement,p_client);o:=s->'package_snapshot'->'membership_terms';
 if o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'
  or c.plan_tier is distinct from o->>'plan_key'
  or c.billing_interval is distinct from(case o->>'payment_option' when 'prepaid' then 'prepaid' else 'monthly' end)
  then raise exception 'retail_period_source_denied';end if;
 perform 1 from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=p_agreement::text order by id for share;
 clock:=clock_timestamp();a:=(s->'original_period'->>'paid_at')::timestamptz;
 span:=(o->'stripe_recurrence'->>'interval_count')::integer;months:=(o->>'commitment_months')::integer;
 if(select count(*) from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=p_agreement::text)>999
  then raise exception 'retail_period_coverage_incomplete';end if;
 for r in select * from public.billing_invoices where retail_period_receipt->'proof'->>'agreement_id'=p_agreement::text
  order by (retail_period_receipt->'proof'->>'ordinal')::integer loop
  w:=r.retail_period_receipt;
  if not coalesce(public.retail_existing_closed_object(w,array['version','source','source_digest','proof','recorded_at']),false)
   or w->>'version' is distinct from 'retail_existing_paid_period_receipt_v1'
   or w->'source' is distinct from s or w->>'source_digest' is distinct from md5(s::text)
   or not coalesce(public.retail_existing_period_proof_valid(w->'proof',s),false)
   or r.stripe_invoice_id is distinct from w->'proof'->>'invoice_id'
   or not exists(select 1 from public.billing_customers where id=r.billing_customer_id and client_id=c.id and stripe_customer_id=c.stripe_customer_id)
   or jsonb_typeof(w->'recorded_at') is distinct from 'string' or not isfinite((w->>'recorded_at')::timestamptz)
   or(w->>'recorded_at')::timestamptz<(w->'proof'->>'paid_at')::timestamptz
   or(w->>'recorded_at')::timestamptz>clock or(w->'proof'->>'paid_at')::timestamptz>clock
   then raise exception 'retail_period_coverage_denied';end if;
  n:=(w->'proof'->>'ordinal')::integer;
  if n=prefix+1 then prefix:=n;end if;
 end loop;
 until_at:=public.retail_existing_month_anchor(a,(prefix+1)*span);
 -- Contract term may advance only when the current A term has begun and its
 -- first installment is in the contiguous funded prefix. Early B stays early B.
 term_index:=((extract(year from clock)::integer-extract(year from a)::integer)*12
  +extract(month from clock)::integer-extract(month from a)::integer)/months;
 term_index:=greatest(0,term_index);
 while term_index>0 and public.retail_existing_month_anchor(a,term_index*months)>clock loop term_index:=term_index-1;end loop;
 funded_term:=case when o->>'payment_option'='prepaid' then prefix else prefix/months end;
 term_index:=least(term_index,funded_term);
 term_start:=public.retail_existing_month_anchor(a,term_index*months);term_end:=public.retail_existing_month_anchor(a,(term_index+1)*months);
 status:=case when clock>=a and clock<until_at then 'active' else 'inactive' end;
 if c.manual_active_override is true then return jsonb_build_object('status','manual_override','funded_through',until_at,'contiguous_ordinal',prefix);end if;
 old_start:=c.contract_start_at;old_end:=c.contract_end_at;
 if old_start is null or old_end is null or not isfinite(old_start) or not isfinite(old_end)
  or old_start<a or old_start>term_start
  or mod(((extract(year from old_start)::integer-extract(year from a)::integer)*12
    +extract(month from old_start)::integer-extract(month from a)::integer),months)<>0
  or old_end is distinct from public.retail_existing_month_anchor(a,
   ((extract(year from old_start)::integer-extract(year from a)::integer)*12
    +extract(month from old_start)::integer-extract(month from a)::integer)+months)
  or old_start is distinct from public.retail_existing_month_anchor(a,
   ((extract(year from old_start)::integer-extract(year from a)::integer)*12
    +extract(month from old_start)::integer-extract(month from a)::integer))
  then raise exception 'retail_period_contract_state_denied';end if;
 update public.clients set billing_status=status,contract_start_at=term_start,contract_end_at=term_end where id=c.id;
 return jsonb_build_object('status','refreshed','billing_status',status,'funded_through',until_at,'contiguous_ordinal',prefix,
  'contract_start_at',term_start,'contract_end_at',term_end);
end $$;

revoke all on function public.retail_existing_period_proof_valid(jsonb,jsonb),public.retail_existing_period_receipt_guard(),
 public.record_retail_existing_paid_period(uuid,uuid,jsonb,jsonb),public.refresh_retail_existing_paid_coverage(uuid,uuid) from public,anon,authenticated;
grant execute on function public.retail_existing_period_proof_valid(jsonb,jsonb),public.retail_existing_period_receipt_guard(),
 public.record_retail_existing_paid_period(uuid,uuid,jsonb,jsonb),public.refresh_retail_existing_paid_coverage(uuid,uuid) to service_role;
commit;
