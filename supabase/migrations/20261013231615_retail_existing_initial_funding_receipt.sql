-- LOCAL CANDIDATE, UNMOUNTED writer. Original captured cash/period evidence only.
-- No paid state, access, client/settings, credits, provider or historical backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[];p record;
begin
 foreach spec slice 1 in array array[
  array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i'],
  array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i'],
  array['retail_existing_checkout_attempt_guard()','57ff63cf55a2764173fdf8bb173aca2f','v'],
  array['claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)','d470cf14fa9cb768f3fcb30d30cb06fe','v'],
  array['pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)','edc56c71c0b5c79e50dc6a99ba0941db','v']] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or p.provolatile::text<>spec[3] or md5(p.prosrc)<>spec[2]
   or p.proconfig is distinct from array['search_path=pg_catalog']
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'retail_funding_prerequisite_drift';end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
  and attname='retail_funding_receipt' and not attisdropped)
  or to_regprocedure('public.record_retail_existing_funding(uuid,uuid,text,jsonb,jsonb)') is not null
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
    and tgname='retail_existing_checkout_attempt_guard' and not tgisinternal and tgenabled='O'
    and tgfoid='public.retail_existing_checkout_attempt_guard()'::regprocedure and tgtype=31)
  or exists(select 1 from pg_class where oid in('public.membership_agreements'::regclass,
    'public.public_purchase_intents'::regclass,'public.clients'::regclass,'public.billing_customers'::regclass) and not relrowsecurity)
  then raise exception 'retail_funding_schema_drift';end if;
end $baseline$;
alter table public.membership_agreements add column retail_funding_receipt jsonb;

create function public.retail_existing_funding_receipt_valid(w jsonb,s jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare p jsonb:=w->'proof';b jsonb:=p->'period';
 offer jsonb:=s->'template_snapshot'->'package_snapshot'->'membership_terms';k text;t timestamptz;r timestamptz;
begin
 if not coalesce(public.retail_existing_closed_object(w,array['version','proof','recorded_at']),false)
  or w->>'version' is distinct from 'retail_existing_funding_v1'
  or not coalesce(public.retail_existing_closed_object(p,array['provider_account_id','period','payment_intent_id','charge_id',
   'checkout_created','invoice_created','platform_gross_cents','platform_discount_cents','platform_net_cents',
   'role_gross_cents','role_discount_cents','role_net_cents','tax_cents','cash_cents']),false)
  or not coalesce(public.retail_existing_closed_object(b,array['version','api_version','invoice_id','platform_invoice_line_id','price_id',
   'subscription_id','subscription_item_id','customer_id','checkout_session_id','livemode','paid_at','provider_period_start','provider_period_end']),false)
  or b->>'version' is distinct from 'retail_initial_provider_period_v1' or b->>'api_version' is distinct from '2023-10-16'
  or jsonb_typeof(b->'livemode') is distinct from 'boolean'
  or not coalesce(public.retail_existing_valid_offer(offer),false) then return false;end if;
 foreach k in array array['provider_account_id','payment_intent_id','charge_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>255
   or p->>k !~ ((case k when 'provider_account_id' then '^acct_' when 'payment_intent_id' then '^pi_' else '^ch_' end)||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 foreach k in array array['invoice_id','platform_invoice_line_id','price_id','subscription_id','subscription_item_id','customer_id','checkout_session_id'] loop
  if jsonb_typeof(b->k) is distinct from 'string' or length(b->>k)>255
   or b->>k !~ ((case k when 'invoice_id' then '^in_' when 'platform_invoice_line_id' then '^il_' when 'price_id' then '^price_'
    when 'subscription_id' then '^sub_' when 'subscription_item_id' then '^si_' when 'customer_id' then '^cus_' else '^cs_' end)||'[A-Za-z0-9_]+$')
   then return false;end if;
 end loop;
 foreach k in array array['checkout_created','invoice_created','platform_gross_cents','platform_discount_cents','platform_net_cents',
   'role_gross_cents','role_discount_cents','role_net_cents','tax_cents','cash_cents'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$'
    or length(p->>k)>16 or (p->>k)::numeric>9007199254740991 then return false;end if;
 end loop;
 foreach k in array array['provider_period_start','provider_period_end'] loop
  if jsonb_typeof(b->k) is distinct from 'number' or b->>k !~ '^[0-9]+$'
    or length(b->>k)>12 or (b->>k)::numeric not between 1 and 253402300799 then return false;end if;
 end loop;
 if (p->>'checkout_created')::numeric not between 1 and 253402300799
  or (p->>'invoice_created')::numeric not between 1 and 253402300799
  or (p->>'checkout_created')::numeric>(p->>'invoice_created')::numeric
  or (b->>'provider_period_start')::numeric>(p->>'invoice_created')::numeric
  or (b->>'provider_period_end')::numeric<=(b->>'provider_period_start')::numeric
  or (p->>'platform_gross_cents')::numeric is distinct from (offer->>'platform_payment_cents')::numeric
  or (p->>'role_gross_cents')::numeric is distinct from (offer->'first_role_prepay'->>'amount_cents')::numeric
  or (p->>'platform_discount_cents')::numeric>(p->>'platform_gross_cents')::numeric
  or (p->>'role_discount_cents')::numeric>(p->>'role_gross_cents')::numeric
  or (p->>'platform_net_cents')::numeric<>(p->>'platform_gross_cents')::numeric-(p->>'platform_discount_cents')::numeric
  or (p->>'role_net_cents')::numeric<>(p->>'role_gross_cents')::numeric-(p->>'role_discount_cents')::numeric
  or (p->>'cash_cents')::numeric<=0
  or (p->>'cash_cents')::numeric<>(p->>'platform_net_cents')::numeric+(p->>'role_net_cents')::numeric+(p->>'tax_cents')::numeric
  or (offer->>'payment_option'='prepaid' and ((p->>'platform_discount_cents')::numeric<>0 or (p->>'role_discount_cents')::numeric<>0))
  or b->>'customer_id' is distinct from s->>'customer_id'
  or jsonb_typeof(b->'paid_at') is distinct from 'string' or jsonb_typeof(w->'recorded_at') is distinct from 'string'
  then return false;end if;
 t:=(b->>'paid_at')::timestamptz;r:=(w->>'recorded_at')::timestamptz;
 return coalesce(isfinite(t) and isfinite(r) and extract(epoch from t) between 1 and 253402300799
  and (p->>'invoice_created')::numeric<=extract(epoch from t)
  and t>=(s->>'signed_at')::timestamptz and t<(s->>'agreement_expires_at')::timestamptz
  and (s->'intent' is null or s->'intent'='null'::jsonb or t<(s->'intent'->>'expires_at')::timestamptz)
  and r>=t and b->>'paid_at'=to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"')
  and w->>'recorded_at'=to_char(r at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),false);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then return false;
end $$;

-- Nonlocking trigger predicate; the record RPC owns the documented row locks.
create function public.retail_existing_funding_context(a public.membership_agreements,p_claim text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.clients;i public.public_purchase_intents;had_intent boolean;m jsonb;
begin
 if current_user<>'service_role' or a.id is null or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_by_agreement_id is not null or a.superseded_at is not null or a.voided_at is not null
  or a.checkout_status is distinct from 'pending_payment' or a.checkout_paid_at is not null
  or a.checkout_attempt_source is null or a.checkout_embedded is null or a.checkout_session_id is null
  then raise exception 'retail_funding_source_denied';end if;
 begin select * into strict i from public.public_purchase_intents where agreement_id=a.id;had_intent:=true;
 exception when no_data_found then had_intent:=false;when too_many_rows then raise exception 'retail_funding_intent_ambiguous';end;
 if had_intent and (i.client_id is distinct from a.client_id or i.status is distinct from 'checkout_pending'
  or i.protocol is distinct from 'fenced_v2' or i.canceled_at is not null or i.activated_at is not null
  or i.stripe_checkout_session_id is distinct from a.checkout_session_id
  or p_claim is null or length(p_claim)<32 or i.activation_claim_key is distinct from p_claim
  or i.activation_claimed_at is null or i.activation_claimed_at<clock_timestamp()-interval '5 minutes') then
  raise exception 'retail_funding_claim_denied';end if;
 if not had_intent and p_claim is not null then raise exception 'retail_funding_admin_claim_denied';end if;
 select * into c from public.clients where id=a.client_id;
 if c.id is null or c.parent_client_id is not null or c.archived_at is not null
  or c.stripe_customer_id is distinct from a.checkout_attempt_source->>'customer_id'
  or (c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from a.replaces_stripe_subscription_id)
  or (select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  then raise exception 'retail_funding_customer_denied';end if;
 m:=public.retail_existing_checkout_material(to_jsonb(a),case when had_intent then to_jsonb(i) else null end,c.stripe_customer_id);
 if m is distinct from a.checkout_attempt_source-'config'
  or not coalesce(public.retail_existing_checkout_config_valid(a.checkout_attempt_source->'config'),false)
  or a.checkout_created_at is null or not isfinite(a.checkout_created_at) or a.checkout_created_at>clock_timestamp()
  then raise exception 'retail_funding_source_changed';end if;
end $$;

create function public.retail_existing_funding_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare w jsonb;
begin
 if TG_OP='DELETE' then if old.retail_funding_receipt is not null then raise exception 'retail_funding_immutable';end if;return old;end if;
 if TG_OP='INSERT' then if new.retail_funding_receipt is not null then raise exception 'retail_funding_record_required';end if;return new;end if;
 if old.retail_funding_receipt is not null then
  if new.retail_funding_receipt is distinct from old.retail_funding_receipt then raise exception 'retail_funding_immutable';end if;
  if (new.checkout_paid_at is not null and new.checkout_paid_at is distinct from (old.retail_funding_receipt->'proof'->'period'->>'paid_at')::timestamptz)
   or (old.checkout_paid_at is not null and new.checkout_paid_at is null) then raise exception 'retail_funding_paid_clock_conflict';end if;
  return new;
 end if;
 if new.retail_funding_receipt is null then return new;end if;
 if current_user<>'service_role' or current_setting('private_sales.retail_funding_writer',true) is distinct from new.id::text
  then raise exception 'retail_funding_record_required';end if;
 perform public.retail_existing_funding_context(new,nullif(current_setting('private_sales.retail_funding_claim',true),''));
 w:=new.retail_funding_receipt;
 if not coalesce(public.retail_existing_closed_object(w,array['version','proof','recorded_at']),false)
  or w->'recorded_at' is distinct from 'null'::jsonb then raise exception 'retail_funding_stamp_required';end if;
 w:=jsonb_set(w,'{recorded_at}',to_jsonb(to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 if not coalesce(public.retail_existing_funding_receipt_valid(w,new.checkout_attempt_source),false)
  or w->'proof'->'period'->>'checkout_session_id' is distinct from new.checkout_session_id
  or (w->'proof'->>'checkout_created')::numeric<floor(extract(epoch from new.checkout_created_at))
  or (w->'proof'->'period'->>'paid_at')::timestamptz>clock_timestamp()
  then raise exception 'retail_funding_proof_denied';end if;
 new.retail_funding_receipt:=w;return new;
end $$;
create trigger retail_existing_funding_guard before insert or update or delete on public.membership_agreements
 for each row execute function public.retail_existing_funding_guard();
alter table public.membership_agreements add constraint retail_existing_funding_receipt_check check(
 retail_funding_receipt is null or public.retail_existing_funding_receipt_valid(retail_funding_receipt,checkout_attempt_source));

create function public.retail_existing_funding_intent_clock_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare w jsonb;
begin
 if TG_OP='UPDATE' then
  select retail_funding_receipt into w from public.membership_agreements where id=old.agreement_id;
  if w is not null and (new.agreement_id is distinct from old.agreement_id or new.client_id is distinct from old.client_id
   or (old.activated_at is not null and new.activated_at is null)) then raise exception 'retail_funding_intent_clock_conflict';end if;
 end if;
 if new.activated_at is null then return new;end if;
 select retail_funding_receipt into w from public.membership_agreements where id=new.agreement_id;
 if w is not null and new.activated_at is distinct from (w->'proof'->'period'->>'paid_at')::timestamptz
  then raise exception 'retail_funding_intent_clock_conflict';end if;
 return new;
end $$;
create trigger retail_existing_funding_intent_clock_guard before insert or update on public.public_purchase_intents
 for each row execute function public.retail_existing_funding_intent_clock_guard();

create unique index retail_funding_one_session on public.membership_agreements
 ((retail_funding_receipt->'proof'->>'provider_account_id'),(retail_funding_receipt->'proof'->'period'->>'livemode'),(retail_funding_receipt->'proof'->'period'->>'checkout_session_id')) where retail_funding_receipt is not null;
create unique index retail_funding_one_subscription on public.membership_agreements
 ((retail_funding_receipt->'proof'->>'provider_account_id'),(retail_funding_receipt->'proof'->'period'->>'livemode'),(retail_funding_receipt->'proof'->'period'->>'subscription_id')) where retail_funding_receipt is not null;
create unique index retail_funding_one_invoice on public.membership_agreements
 ((retail_funding_receipt->'proof'->>'provider_account_id'),(retail_funding_receipt->'proof'->'period'->>'livemode'),(retail_funding_receipt->'proof'->'period'->>'invoice_id')) where retail_funding_receipt is not null;
create unique index retail_funding_one_pi on public.membership_agreements
 ((retail_funding_receipt->'proof'->>'provider_account_id'),(retail_funding_receipt->'proof'->'period'->>'livemode'),(retail_funding_receipt->'proof'->>'payment_intent_id')) where retail_funding_receipt is not null;
create unique index retail_funding_one_charge on public.membership_agreements
 ((retail_funding_receipt->'proof'->>'provider_account_id'),(retail_funding_receipt->'proof'->'period'->>'livemode'),(retail_funding_receipt->'proof'->>'charge_id')) where retail_funding_receipt is not null;

create function public.record_retail_existing_funding(p_agreement uuid,p_client uuid,p_claim text,p_source jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;i public.public_purchase_intents;w jsonb;had_intent boolean;
begin
 if current_user<>'service_role' then raise exception 'retail_funding_server_only';end if;
 begin select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for update;had_intent:=true;
 exception when no_data_found then had_intent:=false;when too_many_rows then raise exception 'retail_funding_intent_ambiguous';end;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from p_client or a.checkout_attempt_source is distinct from p_source then
  raise exception 'retail_funding_source_denied';end if;
 perform 1 from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=a.checkout_attempt_source->>'customer_id' order by id for share;
 perform public.retail_existing_funding_context(a,p_claim);
 if a.retail_funding_receipt is not null then
  if a.retail_funding_receipt->'proof' is distinct from p_proof
   or not coalesce(public.retail_existing_funding_receipt_valid(a.retail_funding_receipt,p_source),false)
   then raise exception 'retail_funding_receipt_conflict';end if;
  return a.retail_funding_receipt;
 end if;
 perform set_config('private_sales.retail_funding_writer',a.id::text,true);
 perform set_config('private_sales.retail_funding_claim',coalesce(p_claim,''),true);
 w:=jsonb_build_object('version','retail_existing_funding_v1','proof',p_proof,'recorded_at',null);
 update public.membership_agreements set retail_funding_receipt=w where id=a.id returning retail_funding_receipt into w;
 if not found or w is null then raise exception 'retail_funding_record_failed';end if;
 perform set_config('private_sales.retail_funding_writer','',true);perform set_config('private_sales.retail_funding_claim','',true);
 return w;
end $$;
revoke all on function public.retail_existing_funding_receipt_valid(jsonb,jsonb),
 public.retail_existing_funding_context(public.membership_agreements,text),public.retail_existing_funding_guard(),
 public.retail_existing_funding_intent_clock_guard(),public.record_retail_existing_funding(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.retail_existing_funding_receipt_valid(jsonb,jsonb),
 public.retail_existing_funding_context(public.membership_agreements,text),public.retail_existing_funding_guard(),
 public.retail_existing_funding_intent_clock_guard(),public.record_retail_existing_funding(uuid,uuid,text,jsonb,jsonb) to service_role;
commit;
