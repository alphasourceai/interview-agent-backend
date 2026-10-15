-- Additive, prospective generation-date compatibility on EXISTING Checkout
-- claim/pin functions. No catalog enablement, paid receipt, access or backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record;constraint_source text;
begin
 foreach spec slice 1 in array array[
  array['retail_existing_valid_offer(jsonb)','acd2d5e1e15c32bfb20e4d0f3439ffcb'],
  array['retail_existing_terms_months(jsonb,jsonb)','f9040629d7954ff583f68622d327ad2b'],
  array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f'],
  array['retail_existing_checkout_attempt_guard()','57ff63cf55a2764173fdf8bb173aca2f'],
  array['claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)','d470cf14fa9cb768f3fcb30d30cb06fe'],
  array['pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)','edc56c71c0b5c79e50dc6a99ba0941db'],
  array['retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94'],
  array['read_retail_existing_recurring_source(uuid,uuid)','0188a99698f4b805a7ade4aff6ac7a84'],
  array['retail_admin_existing_billing_schema_guard()','548328390883f859fee30596f862a6fc'],
  array['retail_admin_existing_member_schema_guard()','5657bc667e754fb0db9ad9f0d8a9359b'],
  array['retail_linked_existing_member_schema_guard()','9e9147468c71a543e44368dd496304cb']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(p.prosrc) is distinct from spec[2] or p.prosecdef
   or p.proisstrict or p.provolatile is distinct from (case
    when spec[1] in ('retail_existing_valid_offer(jsonb)','retail_existing_terms_months(jsonb,jsonb)',
     'retail_existing_checkout_material(jsonb,jsonb,text)','retail_existing_funding_receipt_valid(jsonb,jsonb)') then 'i'::"char"
    when spec[1] like '%schema_guard()' then 's'::"char" else 'v'::"char" end)
   or p.proconfig is distinct from (case
    when spec[1] in ('retail_existing_valid_offer(jsonb)','retail_existing_terms_months(jsonb,jsonb)')
     then array['search_path=pg_catalog, public']
    when spec[1]='read_retail_existing_recurring_source(uuid,uuid)' then array['search_path=pg_catalog','lock_timeout=10s']
    else array['search_path=pg_catalog'] end)
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   or (select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)<>1
   then raise exception 'retail_generation_checkout_prerequisite_drift: %',spec[1];end if;
 end loop;
 if exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
  and attname='retail_checkout_prices' and not attisdropped)
  or to_regprocedure('public.retail_generation_calendar(jsonb)') is not null
  or to_regprocedure('public.retail_generation_prices_valid(jsonb,jsonb)') is not null
  then raise exception 'retail_generation_checkout_schema_drift';end if;
 select pg_get_constraintdef(oid) into constraint_source from pg_constraint
  where conrelid='public.public_purchase_intents'::regclass and conname='public_purchase_intents_term_start_basis_check';
 if constraint_source is distinct from 'CHECK ((term_start_basis = ANY (ARRAY[''agreement_date''::text, ''successful_payment''::text])))'
  then raise exception 'retail_generation_checkout_basis_constraint_drift';end if;
end $baseline$;

alter table public.membership_agreements add column retail_checkout_prices jsonb;
alter table public.public_purchase_intents drop constraint public_purchase_intents_term_start_basis_check;
alter table public.public_purchase_intents add constraint public_purchase_intents_term_start_basis_check check (
 term_start_basis in ('agreement_date','successful_payment') or
 coalesce((term_start_basis='generation_date' and
  package_snapshot->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3' and
  package_snapshot->'membership_terms'->>'term_start_basis'='generation_date'),false));

-- Pure accepted-source calendar. It never reads a current clock or grants
-- payment/access authority. Original-anchor clamping is the existing helper.
create function public.retail_generation_calendar(a jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare s jsonb:=a->'template_snapshot';v jsonb:=s->'values';p jsonb:=s->'package_snapshot';
 o jsonb:=p->'membership_terms';g timestamptz;b timestamptz;e timestamptz;c timestamptz;m integer;
begin
 if o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-15-v3'
  or o->>'term_start_basis' is distinct from 'generation_date'
  or p is distinct from public.retail_existing_package(o)
  or jsonb_typeof(s->'generated_at') is distinct from 'string'
  or s->>'generated_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  then raise exception 'retail_generation_calendar_invalid';end if;
 g:=(s->>'generated_at')::timestamptz;m:=(o->>'commitment_months')::integer;
 b:=date_trunc('day',g at time zone 'UTC') at time zone 'UTC';
 e:=public.retail_existing_month_anchor(b,m);
 c:=public.retail_existing_month_anchor(b,case when o->>'payment_option'='prepaid' then m else 1 end);
 if not isfinite(g) or extract(year from g at time zone 'UTC') not between 1 and 9999
  or s->>'generated_at' is distinct from to_char(g at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  or v->>'term_start_basis' is distinct from 'generation_date'
  or v->>'pricing_version' is distinct from o->>'offer_version'
  or a->>'initial_term_start' is distinct from to_char(b at time zone 'UTC','YYYY-MM-DD')
  or v->>'initial_term_start' is distinct from a->>'initial_term_start'
  or a->>'initial_renewal_date' is distinct from to_char(e at time zone 'UTC','YYYY-MM-DD')
  or v->>'initial_renewal_date' is distinct from a->>'initial_renewal_date'
  then raise exception 'retail_generation_calendar_invalid';end if;
 return jsonb_build_object('generated_at',s->>'generated_at','initial_term_start',a->>'initial_term_start',
  'initial_renewal_date',a->>'initial_renewal_date',
  'first_collection_at',to_char(c at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

create function public.retail_generation_prices_valid(prices jsonb,offer jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text;r boolean;
begin
 if offer->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-15-v3'
  or offer->>'term_start_basis' is distinct from 'generation_date'
  or not public.retail_existing_valid_offer(offer)
  or not coalesce(public.retail_existing_closed_object(prices,array[
   'initial_platform_price_id','recurring_platform_price_id','first_role_price_id']),false) then return false;end if;
 r:=(offer->'first_role_prepay'->>'selected')::boolean;
 foreach k in array array['initial_platform_price_id','recurring_platform_price_id','first_role_price_id'] loop
  if k='first_role_price_id' and not r then
   if prices->k is distinct from 'null'::jsonb then return false;end if;
  elsif jsonb_typeof(prices->k) is distinct from 'string' or length(prices->>k)>255
   or prices->>k !~ '^price_[A-Za-z0-9_]+$' then return false;end if;
 end loop;
 return prices->>'initial_platform_price_id'<>prices->>'recurring_platform_price_id'
  and (not r or (prices->>'first_role_price_id'<>prices->>'initial_platform_price_id'
   and prices->>'first_role_price_id'<>prices->>'recurring_platform_price_id'));
end $$;
revoke all on function public.retail_generation_calendar(jsonb),public.retail_generation_prices_valid(jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function public.retail_generation_calendar(jsonb),public.retail_generation_prices_valid(jsonb,jsonb)
 to service_role;

-- Each exact replacement is narrow; all existing locks, immutable source,
-- customer/config/lease/window/ownership checks and grants remain in place.
do $patch$
declare patch record;d text;sig text;old text;replacement text;
begin
 for patch in select * from(values
 ('retail_existing_valid_offer(jsonb)',
  $old$or p_offer->>'term_start_basis' is distinct from 'first_payment_success'$old$,
  $new$or p_offer->>'term_start_basis' is distinct from (case when p_offer->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 'generation_date' else 'first_payment_success' end)$new$),
 ('retail_existing_funding_receipt_valid(jsonb,jsonb)',
  $old$or not coalesce(public.retail_existing_valid_offer(offer),false) then return false;end if;$old$,
  $new$or not coalesce(public.retail_existing_valid_offer(offer),false)
  -- Generation schedules are not old funded recurring periods. The new native
  -- receipt adaptation is a separate gate; this staged migration grants none.
  or offer->>'term_start_basis' is distinct from 'first_payment_success' then return false;end if;$new$),
 ('retail_existing_terms_months(jsonb,jsonb)',
  $old$or i->>'term_start_basis' is distinct from 'successful_payment'$old$,
  $new$or i->>'term_start_basis' is distinct from (case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 'generation_date' else 'successful_payment' end)$new$),
 ('retail_existing_terms_months(jsonb,jsonb)',
  $old$or v->>'term_start_basis' is distinct from 'successful_payment'$old$,
  $new$or v->>'term_start_basis' is distinct from (case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 'generation_date' else 'successful_payment' end)$new$),
 ('retail_existing_terms_months(jsonb,jsonb)',
  $old$  return (o->>'commitment_months')::integer;$old$,
  $new$  if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then perform public.retail_generation_calendar(a);end if;
  return (o->>'commitment_months')::integer;$new$),
 ('retail_existing_checkout_material(jsonb,jsonb,text)',
  $old$  if octet_length(s::text)>1048576 then$old$,
  $new$  if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
    and signature_time<(s->>'generated_at')::timestamptz then raise exception 'retail_checkout_source_mismatch';end if;
  if octet_length(s::text)>1048576 then$new$),
 ('retail_existing_checkout_material(jsonb,jsonb,text)',
  $old$or v->>'term_start_basis' is distinct from 'successful_payment'$old$,
  $new$or v->>'term_start_basis' is distinct from (case when o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then 'generation_date' else 'successful_payment' end)$new$),
 ('retail_existing_checkout_material(jsonb,jsonb,text)',
  $old$  b:=case when o->>'payment_option'='prepaid' then 'prepaid' else 'monthly' end;$old$,
  $new$  if o->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then perform public.retail_generation_calendar(a);end if;
  b:=case when o->>'payment_option'='prepaid' then 'prepaid' else 'monthly' end;$new$),
 ('retail_existing_checkout_attempt_guard()',
  $old$  if TG_OP='INSERT' then$old$,
  $new$  if TG_OP='INSERT' and new.retail_checkout_prices is not null then
    raise exception 'retail_checkout_prices_pin_required';
  elsif TG_OP='UPDATE' then
    if old.retail_checkout_prices is not null and new.retail_checkout_prices is distinct from old.retail_checkout_prices
      then raise exception 'retail_checkout_prices_immutable';end if;
    if (old.checkout_attempt_source is not null or new.checkout_attempt_source is not null)
      and old.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
      and (new.initial_term_start,new.initial_renewal_date) is distinct from(old.initial_term_start,old.initial_renewal_date)
      then raise exception 'retail_checkout_calendar_immutable';end if;
    if new.retail_checkout_prices is not null and old.retail_checkout_prices is null then
      if current_user<>'service_role' or old.checkout_attempt_source is null or old.checkout_session_id is not null
        or new.checkout_session_id is null
        or not public.retail_generation_prices_valid(new.retail_checkout_prices,
          old.template_snapshot->'package_snapshot'->'membership_terms') then
        raise exception 'retail_checkout_prices_pin_required';end if;
      perform public.retail_generation_calendar(to_jsonb(old));
    end if;
    if old.checkout_session_id is null and new.checkout_session_id is not null
      and new.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
      and new.retail_checkout_prices is null then raise exception 'retail_checkout_prices_pin_required';end if;
  end if;
  if TG_OP='INSERT' then$new$),
 ('claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)',
  $old$  clock:=date_trunc('milliseconds',clock_timestamp());$old$,
  $new$  clock:=date_trunc('milliseconds',clock_timestamp());
  if a.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
    if clock<(public.retail_generation_calendar(to_jsonb(a))->>'generated_at')::timestamptz
      or (public.retail_generation_calendar(to_jsonb(a))->>'first_collection_at')::timestamptz-clock<interval '48 hours'
      then raise exception 'retail_checkout_window_closed';end if;
  end if;$new$),
 ('claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)',
  $old$'replacement_id',a.replaces_stripe_subscription_id,'checkout_session_id',a.checkout_session_id);$old$,
  $new$'replacement_id',a.replaces_stripe_subscription_id,'checkout_session_id',a.checkout_session_id)
    ||case when a.retail_checkout_prices is null then '{}'::jsonb else jsonb_build_object('prices',a.retail_checkout_prices) end;$new$),
 ('pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)',
  $old$  if actual-'checkout_session_id' is distinct from p_attempt-'checkout_session_id'$old$,
  $new$  if actual-'checkout_session_id'-'prices' is distinct from p_attempt-'checkout_session_id'-'prices'$new$),
 ('pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)',
  $old$  begin
    select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for update;had_intent:=true;$old$,
  $new$  if p_attempt->'source'->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3' then
    if not public.retail_generation_prices_valid(p_attempt->'prices',
      p_attempt->'source'->'template_snapshot'->'package_snapshot'->'membership_terms')
      or (actual ? 'prices' and actual->'prices' is distinct from p_attempt->'prices')
      then raise exception 'retail_checkout_pin_prices_changed';end if;
  elsif p_attempt ? 'prices' then raise exception 'retail_checkout_pin_prices_changed';end if;
  begin
    select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for update;had_intent:=true;$new$),
 ('pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)',
  $old$  update public.membership_agreements set checkout_session_id=p_session,checkout_status='pending_payment',$old$,
  $new$  update public.membership_agreements set checkout_session_id=p_session,checkout_status='pending_payment',
    retail_checkout_prices=case when p_attempt ? 'prices' then p_attempt->'prices' else null end,$new$),
 ('pin_retail_existing_checkout_session(uuid,uuid,jsonb,text)',
  $old$  return actual||jsonb_build_object('checkout_session_id',p_session);$old$,
  $new$  return actual||jsonb_build_object('checkout_session_id',p_session)
    ||case when p_attempt ? 'prices' then jsonb_build_object('prices',p_attempt->'prices') else '{}'::jsonb end;$new$)
 ) as t(signature,needle,addition) loop
  sig:='public.'||patch.signature;old:=patch.needle;replacement:=patch.addition;
  select pg_get_functiondef(to_regprocedure(sig)) into d;
  if d is null or (length(d)-length(replace(d,old,'')))/length(old)<>1
    then raise exception 'retail_generation_checkout_patch_drift: %',sig;end if;
  execute replace(d,old,replacement);
 end loop;
end $patch$;

-- Refresh the reviewed dependency DAG, not the guard policy. Baseline hashes
-- above prove all four original guard bodies; unchanged dependency checks stay.
do $fingerprints$
declare guard text;dependency text;old_hash text;new_hash text;d text;entry record;self_hash text;
 calendar_hash text;prices_hash text;marker text;addition text;
begin
 select md5(prosrc) into calendar_hash from pg_proc where oid='public.retail_generation_calendar(jsonb)'::regprocedure;
 select md5(prosrc) into prices_hash from pg_proc where oid='public.retail_generation_prices_valid(jsonb,jsonb)'::regprocedure;
 foreach guard in array array['read_retail_existing_recurring_source(uuid,uuid)',
  'retail_admin_existing_billing_schema_guard()','retail_admin_existing_member_schema_guard()',
  'retail_linked_existing_member_schema_guard()'] loop
  select pg_get_functiondef(to_regprocedure('public.'||guard)) into d;
  for entry in select * from(values
   ('retail_existing_valid_offer(jsonb)','acd2d5e1e15c32bfb20e4d0f3439ffcb'),
   ('retail_existing_terms_months(jsonb,jsonb)','f9040629d7954ff583f68622d327ad2b'),
   ('retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f'),
   ('retail_existing_checkout_attempt_guard()','57ff63cf55a2764173fdf8bb173aca2f'),
   ('retail_existing_funding_receipt_valid(jsonb,jsonb)','655f4866f0cf52144c3abf76bc02ac94'),
   ('retail_admin_existing_billing_schema_guard()','548328390883f859fee30596f862a6fc'),
   ('retail_admin_existing_member_schema_guard()','5657bc667e754fb0db9ad9f0d8a9359b')
  ) as deps(signature,hash) loop
   dependency:=entry.signature;old_hash:=entry.hash;
   select md5(prosrc) into new_hash from pg_proc where oid=to_regprocedure('public.'||dependency);
   if position(quote_literal(old_hash) in d)>0 then d:=replace(d,quote_literal(old_hash),quote_literal(new_hash));end if;
  end loop;
  if guard='read_retail_existing_recurring_source(uuid,uuid)' then
   marker:=E'  foreach spec slice 1 in array array[\n';
   addition:=marker||format(E'   array[''retail_generation_calendar(jsonb)'',%L,''i'',''catalog''],\n   array[''retail_generation_prices_valid(jsonb,jsonb)'',%L,''i'',''catalog''],\n   array[''retail_existing_month_anchor(timestamptz,integer)'',''215a4af8ed5457b66f11e6234f7f5741'',''i'',''public''],\n',calendar_hash,prices_hash);
   if (length(d)-length(replace(d,marker,'')))/length(marker)<>1
    or (length(d)-length(replace(d,'or meta.prosecdef or meta.proisstrict','')))/length('or meta.prosecdef or meta.proisstrict')<>1
    then raise exception 'retail_generation_checkout_guard_patch_drift';end if;
   d:=replace(d,marker,addition);
   d:=replace(d,'or meta.prosecdef or meta.proisstrict',
    'or meta.prosecdef or meta.proisstrict is distinct from(spec[1]=''retail_existing_month_anchor(timestamptz,integer)'')');
  elsif guard='retail_admin_existing_billing_schema_guard()' then
   marker:=E' foreach spec slice 1 in array array[\n';
   addition:=marker||format(E'  array[''retail_generation_calendar(jsonb)'',%L,''i'',''''],\n  array[''retail_generation_prices_valid(jsonb,jsonb)'',%L,''i'',''''],\n',calendar_hash,prices_hash);
   if (length(d)-length(replace(d,marker,'')))/length(marker)<>1
    then raise exception 'retail_generation_checkout_guard_patch_drift';end if;
   d:=replace(d,marker,addition);
  elsif guard='retail_linked_existing_member_schema_guard()' then
   marker:=E' foreach spec slice 1 in array array[\n  array[''public.retail_admin_existing_member_schema_guard()''';
   addition:=E' foreach spec slice 1 in array array[\n'||format(E'  array[''public.retail_generation_calendar(jsonb)'',%L,''i'',''invoker'',''catalog'',''service''],\n  array[''public.retail_generation_prices_valid(jsonb,jsonb)'',%L,''i'',''invoker'',''catalog'',''service''],\n',calendar_hash,prices_hash)
    ||'  array[''public.retail_admin_existing_member_schema_guard()''';
   if (length(d)-length(replace(d,marker,'')))/length(marker)<>1
    then raise exception 'retail_generation_checkout_guard_patch_drift';end if;
   d:=replace(d,marker,addition);
  end if;
  execute d;
  if guard='retail_linked_existing_member_schema_guard()' then
   select md5(regexp_replace(prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
    into self_hash from pg_proc where oid=to_regprocedure('public.'||guard);
   if (length(d)-length(replace(d,'SELF_MD5:5dffd1f8256a907a96407cb8eb5f4e92','')))/length('SELF_MD5:5dffd1f8256a907a96407cb8eb5f4e92')<>1
    then raise exception 'retail_generation_checkout_self_fingerprint_drift';end if;
   execute replace(d,'SELF_MD5:5dffd1f8256a907a96407cb8eb5f4e92','SELF_MD5:'||self_hash);
  end if;
 end loop;
end $fingerprints$;
-- Exercise the final transitive hashes and linked self-pin before commit.
select public.retail_admin_existing_billing_schema_guard();
select public.retail_admin_existing_member_schema_guard();
select public.retail_linked_existing_member_schema_guard();
commit;
