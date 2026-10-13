-- LOCAL receipt-only: existing agreement/pool, no activation/Auth/credit release.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record; x record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_existing_pending_material(jsonb,jsonb,jsonb)','2b81b06a731c0711ad382c66c1e520c1'],
  array['enterprise_existing_pending_config_valid(jsonb)','9cc98f839fddb9ee2d140608c0b40bf1'],
  array['enterprise_existing_pending_expiry(timestamptz,timestamptz)','f0ad469d7098bf27e6b76c913202d697'],
  array['enterprise_existing_pending_agreement_guard()','3b66f33ed9b06c128256eb5e7dea7ac7'],
  array['enterprise_existing_pending_pool_guard()','baeb4233953221be03c32114eb2c7ee6'],
  array['enterprise_existing_pending_pair_guard()','4e81301443662fc1f5bef56966b866e0'],
  array['claim_enterprise_existing_pending_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb)','081cb824284105a582d792f24eb453aa'],
  array['enterprise_pool_v2_guard_pool()','5ec10701ca59c0c9fd6735a6f644c1a0'],
  array['enterprise_pool_v2_guard_agreement()','f556d965930467187ec3b4de8ee11542'],
  array['enterprise_pool_v2_guard_source()','483cc416ab9ee7e3017f3ee8d0490daa'],
  array['enterprise_v2_signing_requires_seal()','eb87e1661cf367050af8a859340ded6e']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or md5(p.prosrc)<>spec[2] or p.proconfig is distinct from
   (case when spec[1] like 'claim_%' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_funding_prerequisite_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_existing_pending_agreement_guard','enterprise_existing_pending_agreement_guard',31,false),
  ('client_interview_pools','enterprise_existing_pending_pool_guard','enterprise_existing_pending_pool_guard',31,false),
  ('membership_agreements','enterprise_existing_pending_agreement_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_existing_pending_pool_pair','enterprise_existing_pending_pair_guard',21,true),
  ('client_interview_pools','enterprise_pool_v2_guard_pool','enterprise_pool_v2_guard_pool',31,false),
  ('membership_agreements','enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_source',27,false),
  ('membership_agreements','enterprise_v2_signing_requires_seal','enterprise_v2_signing_requires_seal',19,false)
 )t(tab,name,func,kind,deferred) loop
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||x.tab) and tgname=x.name and tgenabled='O'
   and tgtype=x.kind and tgfoid=to_regprocedure('public.'||x.func||'()') and tgdeferrable=x.deferred and tginitdeferred=x.deferred)
   then raise exception 'enterprise_funding_trigger_drift';end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass and attname='enterprise_funding_receipt' and not attisdropped)
  or not exists(select 1 from pg_class where oid='public.client_interview_pools'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.membership_agreements'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.enterprise_v2_execution_seals'::regclass and relrowsecurity)
  or has_table_privilege('anon','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.enterprise_v2_execution_seals','SELECT,INSERT')
  or has_table_privilege('service_role','public.enterprise_v2_execution_seals','UPDATE,DELETE,TRUNCATE')
  or exists(select 1 from pg_policies where schemaname='public' and tablename in('client_interview_pools','enterprise_v2_execution_seals'))
  then raise exception 'enterprise_funding_schema_acl_drift';end if;
 foreach spec slice 1 in array array[
  array['enterprise_pool_v2_snapshot_check','207ca2f1615bd52298ca296c582563b6'],
  array['client_interview_pools_total_check','11bf823dae61f175be0a7acf76bacaed'],
  array['client_interview_pools_status_check','6bb064e6f03e464e7a80304b9eaa163a'],
  array['client_interview_pools_discount_check','d6a426fad89ecefcae48770cd15ca656'],
  array['client_interview_pools_quantity_check','70a754901507cc93dbc7d569ab5ac563'],
  array['client_interview_pools_unit_price_check','f611d5276579a2181341465e4b9bce18']] loop
  if not exists(select 1 from pg_constraint where conrelid='public.client_interview_pools'::regclass and conname=spec[1]
   and contype='c' and convalidated and md5(pg_get_constraintdef(oid))=spec[2]) then raise exception 'enterprise_funding_check_drift';end if;
 end loop;
 for x in select * from(values
  ('membership_agreements','enterprise_checkout_source','jsonb'),('membership_agreements','enterprise_checkout_pool_id','uuid'),
  ('membership_agreements','checkout_created_at','timestamptz'),('membership_agreements','checkout_paid_at','timestamptz'),
  ('membership_agreements','checkout_status','text'),('membership_agreements','checkout_session_id','text'),
  ('membership_agreements','checkout_attempt_source','jsonb'),('membership_agreements','checkout_embedded','boolean'),
  ('membership_agreements','replaces_stripe_subscription_id','text'),('membership_agreements','replacement_policy','text'),
  ('client_interview_pools','agreement_id','uuid'),('client_interview_pools','stripe_checkout_session_id','text'),
  ('client_interview_pools','stripe_payment_intent_id','text'),('client_interview_pools','paid_at','timestamptz')
 )t(tab,name,type) loop
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||x.tab) and attname=x.name and atttypid=to_regtype(x.type)
   and not attnotnull and not attisdropped) then raise exception 'enterprise_funding_column_drift';end if;
 end loop;
 if not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='agreement_id'
  where i.indexrelid=to_regclass('public.enterprise_pool_one_initial_agreement') and i.indisunique and i.indisvalid
   and i.indnkeyatts=1 and i.indkey[0]=a.attnum and pg_get_expr(i.indpred,i.indrelid)='(agreement_id IS NOT NULL)')
  or (select count(*) from pg_constraint where contype='f' and convalidated and confdeltype='r' and
   ((conrelid='public.membership_agreements'::regclass and confrelid='public.client_interview_pools'::regclass
    and conkey=array[(select attnum from pg_attribute where attrelid=conrelid and attname='enterprise_checkout_pool_id')])
   or(conrelid='public.client_interview_pools'::regclass and confrelid='public.membership_agreements'::regclass
    and conkey=array[(select attnum from pg_attribute where attrelid=conrelid and attname='agreement_id')])))<>2
  then raise exception 'enterprise_funding_pair_schema_drift';end if;
end $baseline$;

do $owner_baseline$
begin
 if not exists(select 1 from pg_class where oid='public.billing_customers'::regclass and relrowsecurity)
  -- PostgreSQL SELECT FOR SHARE also requires UPDATE privilege. Do not hide
  -- an insufficient target grant by changing ACL or using SECURITY DEFINER.
  -- Comma-separated has_table_privilege means ANY, not ALL privileges.
  or not has_table_privilege('service_role','public.billing_customers','SELECT')
  or not has_table_privilege('service_role','public.billing_customers','UPDATE')
  or not has_table_privilege('service_role','public.clients','SELECT')
  or not has_table_privilege('service_role','public.clients','UPDATE')
  or not has_table_privilege('service_role','public.membership_agreements','SELECT')
  or not has_table_privilege('service_role','public.membership_agreements','UPDATE')
  or not has_table_privilege('service_role','public.client_interview_pools','SELECT')
  or not has_table_privilege('service_role','public.client_interview_pools','UPDATE')
  or not exists(select 1 from pg_attribute where attrelid='public.clients'::regclass and attname='stripe_subscription_id'
   and atttypid='text'::regtype and not attnotnull and not attisdropped)
  or not exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass and attname='enterprise_checkout_prices'
   and atttypid='jsonb'::regtype and not attnotnull and not attisdropped)
  or not exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname='stripe_customer_id'
   where i.indrelid='public.billing_customers'::regclass and i.indisunique and i.indisvalid and i.indisready
    and i.indnkeyatts=1 and i.indkey[0]=a.attnum and pg_get_expr(i.indpred,i.indrelid)='(stripe_customer_id IS NOT NULL)')
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'enterprise_existing_funding_%')
  or to_regprocedure('public.record_enterprise_existing_funding(uuid,uuid,jsonb,jsonb,jsonb)') is not null
  then raise exception 'enterprise_funding_owner_schema_drift';end if;
end $owner_baseline$;
alter table public.membership_agreements add column enterprise_funding_receipt jsonb;

-- Binding/shape, NOT provider authentication. Only the trusted SDK reader can
-- supply financial evidence. No changing-now predicate inside this CHECK.
create function public.enterprise_existing_funding_receipt_valid(w jsonb,s jsonb,prices jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare p jsonb;v jsonb;o jsonb;k text;spec text[];paid timestamptz;recorded timestamptz;b timestamptz;legal timestamptz;
 nominal numeric;keys text[]:=array['pool_id','client_id','provider_account_id','livemode','currency','offer_version','offer_digest','customer_id',
 'checkout_session_id','subscription_id','invoice_id','pool_line_id','payment_intent_id','charge_id','platform_item_id','platform_price_id','pool_price_id',
 'platform_interval','platform_nominal_cents','payment_success_at','quantity','pool_paid_cents','pool_tax_cents','platform_line_cents','tax_cents',
 'collected_cents','credits_spendable','membership_activation_required','native_receipt_required'];
begin
 if jsonb_typeof(w) is distinct from 'object' or(select count(*) from jsonb_object_keys(w))<>3
  or not(w ?& array['version','proof','recorded_at']) or w->>'version' is distinct from 'enterprise_existing_funding_v1'
  or jsonb_typeof(w->'recorded_at') is distinct from 'string' or w->>'recorded_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
  then return false;end if;
 p:=w->'proof';
 if jsonb_typeof(p) is distinct from 'object' or(select count(*) from jsonb_object_keys(p))<>29 or not(p ?& keys)
  or p->>'currency' is distinct from 'usd' or jsonb_typeof(p->'livemode') is distinct from 'boolean'
  or jsonb_typeof(p->'offer_version') is distinct from 'string' or jsonb_typeof(p->'offer_digest') is distinct from 'string'
  or p->>'offer_digest' !~ '^[0-9a-f]{64}$'
  or p->'credits_spendable' is distinct from 'false'::jsonb or p->'membership_activation_required' is distinct from 'true'::jsonb
  or p->'native_receipt_required' is distinct from 'true'::jsonb then return false;end if;
 foreach k in array array['platform_nominal_cents','quantity','pool_paid_cents','pool_tax_cents','platform_line_cents','tax_cents','collected_cents'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$' or(p->>k)::numeric>2147483647 then return false;end if;
 end loop;
 foreach spec slice 1 in array array[
  array['provider_account_id','acct'],array['customer_id','cus'],array['checkout_session_id','cs'],array['subscription_id','sub'],
  array['invoice_id','in'],array['pool_line_id','il'],array['payment_intent_id','pi'],array['charge_id','ch'],array['platform_item_id','si'],
  array['platform_price_id','price'],array['pool_price_id','price']] loop
  if jsonb_typeof(p->spec[1]) is distinct from 'string' or length(p->>spec[1])>500 or p->>spec[1] !~ ('^'||spec[2]||'_[A-Za-z0-9_]+$') then return false;end if;
 end loop;
 foreach k in array array['pool_id','client_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
 end loop;
 if jsonb_typeof(s) is distinct from 'object' or s->>'version' is distinct from 'enterprise_existing_pending_v1'
  or not coalesce(public.enterprise_existing_checkout_prices_valid(prices),false) then return false;end if;
 v:=s->'material'->'template_snapshot'->'values';o:=v->'pool_offer_snapshot';
 if not coalesce(public.enterprise_pool_v2_valid_offer(o),false)
  or s->'material'->>'membership_tier' is distinct from 'enterprise' or v->>'billing_model' is distinct from 'usage'
  or s->'material'->>'billing_option' not in('monthly','annual')
  or jsonb_typeof(v->'platform_fee') not in('number','string') or coalesce(v->>'platform_fee','') !~ '^[0-9]+(\.[0-9]{1,2})?$'
  then return false;end if;
 nominal:=(v->>'platform_fee')::numeric*100;
 if nominal<=0 or nominal>2147483647 or p->>'pool_id' is distinct from s->>'pool_id'
  or p->>'client_id' is distinct from s->'material'->>'client_id' or p->>'customer_id' is distinct from s->'material'->>'customer_id'
  or p->>'platform_price_id' is distinct from prices->>'platform_price_id' or p->>'pool_price_id' is distinct from prices->>'pool_price_id'
  or p->>'subscription_id' is not distinct from s->>'replacement_id'
  or p->>'offer_version' is distinct from o->>'offer_version' or p->>'offer_digest' is distinct from v->>'pool_offer_digest'
  or p->>'platform_interval' is distinct from(case when s->'material'->>'billing_option'='annual' then 'year' else 'month' end)
  or(p->>'platform_nominal_cents')::numeric<>nominal or(p->>'quantity')::bigint<1 or(p->>'quantity')::bigint<>(o->>'quantity')::bigint
  or(p->>'pool_paid_cents')::bigint<=0 or(p->>'pool_paid_cents')::bigint<>(o->>'net_cents')::bigint
  or(p->>'platform_line_cents')::numeric>nominal or(p->>'pool_tax_cents')::bigint>(p->>'tax_cents')::bigint
  or(p->>'collected_cents')::bigint<=0 or(p->>'collected_cents')::bigint<>
   (p->>'pool_paid_cents')::bigint+(p->>'platform_line_cents')::bigint+(p->>'tax_cents')::bigint then return false;end if;
 if jsonb_typeof(p->'payment_success_at') is distinct from 'string' or p->>'payment_success_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$'
  then return false;end if;
 paid:=(p->>'payment_success_at')::timestamptz;recorded:=(w->>'recorded_at')::timestamptz;
 b:=(s->>'created_at')::timestamptz;legal:=(s->'material'->>'agreement_expires_at')::timestamptz;
 return coalesce(isfinite(paid) and isfinite(recorded) and isfinite(b) and isfinite(legal)
  and extract(epoch from paid)>0 and extract(epoch from paid)<=253402300799
  and extract(epoch from paid)>=ceil(extract(epoch from b))
  and paid>=(s->'material'->'template_snapshot'->'execution'->>'signed_at')::timestamptz and paid<legal and recorded>=paid
  and p->>'payment_success_at'=to_char(paid at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"')
  and w->>'recorded_at'=to_char(recorded at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),false);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then return false;
end $$;

-- Nonlocking predicate for trigger use: do not invert agreement -> client locks.
-- The RPC obtains client -> agreement -> pool -> profile FOR SHARE first.
create function public.enterprise_existing_funding_context(a public.membership_agreements)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients;p public.client_interview_pools;s public.enterprise_v2_execution_seals;src jsonb;b timestamptz;expiry timestamptz;
begin
 if current_user<>'service_role' or a.id is null or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.checkout_status is distinct from 'pending_payment'
  or a.checkout_paid_at is not null or a.checkout_attempt_source is not null or a.checkout_embedded is not null
  or a.enterprise_checkout_source is null or a.enterprise_checkout_pool_id is null or a.checkout_session_id is null
  or a.checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
  or not coalesce(public.enterprise_existing_checkout_prices_valid(a.enterprise_checkout_prices),false)
  or exists(select 1 from public.public_purchase_intents where agreement_id=a.id) then raise exception 'enterprise_funding_source_denied';end if;
 select * into c from public.clients where id=a.client_id;
 select * into s from public.enterprise_v2_execution_seals where agreement_id=a.id;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id;
 src:=a.enterprise_checkout_source;
 if c.id is null or s.agreement_id is null or p.id is null or c.parent_client_id is not null or c.archived_at is not null
  or public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(s)) is distinct from src->'material'
  or src->>'pool_id' is distinct from p.id::text or p.client_id is distinct from c.id or p.agreement_id is distinct from a.id
  or p.status is distinct from 'pending' or p.paid_at is not null or p.stripe_payment_intent_id is not null
  or p.stripe_checkout_session_id is distinct from a.checkout_session_id or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest'
  or(c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from src->>'replacement_id')
  or a.replaces_stripe_subscription_id is distinct from src->>'replacement_id'
  or a.replacement_policy is distinct from(case when src->>'replacement_id' is null then null else 'immediate_cancel' end)
  or(select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  then raise exception 'enterprise_funding_binding_denied';end if;
 b:=(src->>'created_at')::timestamptz;expiry:=(src->>'expires_at')::timestamptz;
 if not coalesce(isfinite(b),false) or b>clock_timestamp() or a.checkout_created_at is distinct from b
  or expiry is distinct from public.enterprise_existing_pending_expiry(b,a.agreement_expires_at)
  then raise exception 'enterprise_funding_source_clock_denied';end if;
end $$;

create function public.enterprise_existing_funding_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare w jsonb;
begin
 if TG_OP='DELETE' then if old.enterprise_funding_receipt is not null then raise exception 'enterprise_funding_immutable';end if;return old;end if;
 if TG_OP='INSERT' then if new.enterprise_funding_receipt is not null then raise exception 'enterprise_funding_record_required';end if;return new;end if;
 if old.enterprise_funding_receipt is not null then
  if new.enterprise_funding_receipt is distinct from old.enterprise_funding_receipt then raise exception 'enterprise_funding_immutable';end if;return new;
 end if;
 if new.enterprise_funding_receipt is null then return new;end if;
 perform public.enterprise_existing_funding_context(new);
 w:=new.enterprise_funding_receipt;
 if jsonb_typeof(w) is distinct from 'object' or(select count(*) from jsonb_object_keys(w))<>3
  or not(w ?& array['version','proof','recorded_at']) or w->'recorded_at' is distinct from 'null'::jsonb
  then raise exception 'enterprise_funding_stamp_required';end if;
 w:=jsonb_set(w,'{recorded_at}',to_jsonb(to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 if not coalesce(public.enterprise_existing_funding_receipt_valid(w,new.enterprise_checkout_source,new.enterprise_checkout_prices),false)
  or w->'proof'->>'checkout_session_id' is distinct from new.checkout_session_id
  or(w->'proof'->>'payment_success_at')::timestamptz>clock_timestamp()
  then raise exception 'enterprise_funding_proof_denied';end if;
 new.enterprise_funding_receipt:=w;return new;
end $$;
create trigger enterprise_existing_funding_guard before insert or update or delete on public.membership_agreements
 for each row execute function public.enterprise_existing_funding_guard();
alter table public.membership_agreements add constraint enterprise_existing_funding_receipt_check check(
 enterprise_funding_receipt is null or public.enterprise_existing_funding_receipt_valid(enterprise_funding_receipt,enterprise_checkout_source,enterprise_checkout_prices));

create unique index enterprise_funding_one_checkout on public.membership_agreements
 ((enterprise_funding_receipt->'proof'->>'provider_account_id'),(enterprise_funding_receipt->'proof'->>'livemode'),(enterprise_funding_receipt->'proof'->>'checkout_session_id')) where enterprise_funding_receipt is not null;
create unique index enterprise_funding_one_subscription on public.membership_agreements
 ((enterprise_funding_receipt->'proof'->>'provider_account_id'),(enterprise_funding_receipt->'proof'->>'livemode'),(enterprise_funding_receipt->'proof'->>'subscription_id')) where enterprise_funding_receipt is not null;
create unique index enterprise_funding_one_invoice on public.membership_agreements
 ((enterprise_funding_receipt->'proof'->>'provider_account_id'),(enterprise_funding_receipt->'proof'->>'livemode'),(enterprise_funding_receipt->'proof'->>'invoice_id')) where enterprise_funding_receipt is not null;
create unique index enterprise_funding_one_pi on public.membership_agreements
 ((enterprise_funding_receipt->'proof'->>'provider_account_id'),(enterprise_funding_receipt->'proof'->>'livemode'),(enterprise_funding_receipt->'proof'->>'payment_intent_id')) where enterprise_funding_receipt is not null;
create unique index enterprise_funding_one_charge on public.membership_agreements
 ((enterprise_funding_receipt->'proof'->>'provider_account_id'),(enterprise_funding_receipt->'proof'->>'livemode'),(enterprise_funding_receipt->'proof'->>'charge_id')) where enterprise_funding_receipt is not null;

create function public.record_enterprise_existing_funding(p_agreement uuid,p_client uuid,p_source jsonb,p_prices jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;p public.client_interview_pools;owner_id uuid;w jsonb;
begin
 if current_user<>'service_role' then raise exception 'enterprise_funding_server_only';end if;
 select * into c from public.clients where id=p_client for update;
 if not found then raise exception 'enterprise_funding_parent_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.enterprise_checkout_source is distinct from p_source
  or a.enterprise_checkout_prices is distinct from p_prices then raise exception 'enterprise_funding_source_denied';end if;
 select * into p from public.client_interview_pools where id=a.enterprise_checkout_pool_id for update;
 if not found then raise exception 'enterprise_funding_pool_denied';end if;
 select id into owner_id from public.billing_customers where stripe_customer_id=c.stripe_customer_id for share;
 if not found then raise exception 'enterprise_funding_owner_denied';end if;
 perform public.enterprise_existing_funding_context(a);
 if a.enterprise_funding_receipt is not null then
  if a.enterprise_funding_receipt->'proof' is distinct from p_proof
   or not coalesce(public.enterprise_existing_funding_receipt_valid(a.enterprise_funding_receipt,p_source,p_prices),false)
   then raise exception 'enterprise_funding_receipt_conflict';end if;
  return a.enterprise_funding_receipt;
 end if;
 w:=jsonb_build_object('version','enterprise_existing_funding_v1','proof',p_proof,'recorded_at',null);
 update public.membership_agreements set enterprise_funding_receipt=w where id=a.id returning enterprise_funding_receipt into w;
 if not found then raise exception 'enterprise_funding_record_failed';end if;
 return w;
end $$;

revoke all on function public.enterprise_existing_funding_receipt_valid(jsonb,jsonb,jsonb),
 public.enterprise_existing_funding_context(public.membership_agreements),public.enterprise_existing_funding_guard(),
 public.record_enterprise_existing_funding(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enterprise_existing_funding_receipt_valid(jsonb,jsonb,jsonb),
 public.enterprise_existing_funding_context(public.membership_agreements),public.enterprise_existing_funding_guard(),
 public.record_enterprise_existing_funding(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
commit;
