-- LOCAL ONLY. Conditional trace linkage on the existing native rows. This RPC
-- does NOT attest Stripe funding; the server must verify the SDK Session first.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record;
begin
  foreach spec slice 1 in array array[
    array['retail_existing_checkout_material(jsonb,jsonb,text)','67699a36b8267739c5655764a7c0203f','i'],
    array['retail_existing_checkout_config_valid(jsonb)','c433714eff703c41b1590f890dc8ba7d','i'],
    array['retail_existing_checkout_attempt_guard()','57ff63cf55a2764173fdf8bb173aca2f','v'],
    array['claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)','223daa3cbb35b96bd23120500e56a7a5','v']] loop
    select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
    if not found or p.prosecdef or p.provolatile::text<>spec[3] or md5(p.prosrc)<>spec[2]
      or p.proconfig is distinct from array['search_path=pg_catalog']
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or not has_function_privilege('service_role',p.oid,'EXECUTE') then
      raise exception 'retail_checkout_pin_prerequisite_drift';
    end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
    and tgname='retail_existing_checkout_attempt_guard' and not tgisinternal and tgenabled='O'
    and tgfoid='public.retail_existing_checkout_attempt_guard()'::regprocedure and tgtype=31) then
    raise exception 'retail_checkout_pin_trigger_drift';
  end if;
end $baseline$;

create function public.pin_retail_existing_checkout_session(p_agreement uuid,p_client uuid,p_attempt jsonb,p_session text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare actual jsonb; i public.public_purchase_intents; had_intent boolean;
begin
  if current_user<>'service_role' then raise exception 'retail_checkout_server_only';end if;
  if p_session is null or length(p_session)>255 or p_session !~ '^cs_[A-Za-z0-9_]+$'
    or jsonb_typeof(p_attempt) is distinct from 'object' then raise exception 'retail_checkout_pin_invalid';end if;
  perform set_config('lock_timeout','10s',true);
  -- Claim takes intent -> agreement locks and derives all accepted material
  -- afresh from those rows. Same transaction retains them through both links.
  actual:=public.claim_retail_existing_checkout_attempt(p_agreement,p_client,
    p_attempt->'source'->'template_snapshot',p_attempt->'source'->>'customer_id',
    (p_attempt->>'embedded')::boolean,p_attempt->>'replacement_id',p_attempt->'source'->'config');
  -- Preserve intent -> agreement -> client ordering of funded writers. The
  -- initial claim reads the customer; pin locks it and derives the source again
  -- so a concurrent customer move cannot race between that read and linkage.
  perform 1 from public.clients where id=p_client for update;
  actual:=public.claim_retail_existing_checkout_attempt(p_agreement,p_client,
    p_attempt->'source'->'template_snapshot',p_attempt->'source'->>'customer_id',
    (p_attempt->>'embedded')::boolean,p_attempt->>'replacement_id',p_attempt->'source'->'config');
  if actual-'checkout_session_id' is distinct from p_attempt-'checkout_session_id'
    or (actual->>'checkout_session_id' is not null and actual->>'checkout_session_id'<>p_session)
    or (p_attempt->>'checkout_session_id' is not null and p_attempt->>'checkout_session_id'<>p_session) then
    raise exception 'retail_checkout_pin_attempt_changed';
  end if;
  begin
    select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for update;had_intent:=true;
  exception when no_data_found then had_intent:=false;
    when too_many_rows then raise exception 'retail_checkout_intent_ambiguous';end;
  if had_intent and i.stripe_checkout_session_id is not null and i.stripe_checkout_session_id<>p_session then
    raise exception 'retail_checkout_pin_intent_session_changed';
  end if;
  update public.membership_agreements set checkout_session_id=p_session,checkout_status='pending_payment',
    replacement_policy=case when replaces_stripe_subscription_id is null then null else 'immediate_cancel' end,
    replacement_error=null,updated_at=clock_timestamp() where id=p_agreement;
  if had_intent then
    update public.public_purchase_intents set stripe_checkout_session_id=p_session,status='checkout_pending',
      updated_at=clock_timestamp() where id=i.id;
  end if;
  return actual||jsonb_build_object('checkout_session_id',p_session);
end $$;
revoke all on function public.pin_retail_existing_checkout_session(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.pin_retail_existing_checkout_session(uuid,uuid,jsonb,text) to service_role;
commit;
