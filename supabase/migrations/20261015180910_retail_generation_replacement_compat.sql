-- Existing replacement journal/proof only. Prospective exact v3 branch.
-- No new route, cancellation operation, backfill, Auth or provider call.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[];p record;
begin
 foreach spec slice 1 in array array[
  array['private_retail_replacement.proof(uuid,uuid,text,jsonb)','2239f099a317152917531aaefd3667e9','v','lock','service'],
  array['private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)','478877d38d37f0d457baa1706e6430f4','v','lock','owner'],
  array['private_retail_replacement.schema_guard()','37fe432da3b8c33266c3eb267f280126','s','','service'],
  array['public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)','33f40ea333ce482b363fa10fdf0ea5ff','v','empty','service'],
  array['public.retail_linked_existing_member_schema_guard()','6ecfd1b5462f70f44c8f8648047a0324','s','','service']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure(spec[1]);
  if not found or md5(p.prosrc) is distinct from spec[2] or p.provolatile::text is distinct from spec[3]
   or p.proisstrict or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.prosecdef is distinct from(spec[4]='empty')
   or p.proconfig is distinct from(case spec[4] when 'empty' then array['search_path=""']
    when 'lock' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee<>p.proowner and(spec[5]='owner' or grantee<>(select oid from pg_roles where rolname='service_role')))
   or(spec[5]='service' and not has_function_privilege('service_role',p.oid,'execute'))
   or(select count(*) from pg_proc where pronamespace=p.pronamespace and proname=p.proname)<>1
   then raise exception 'retail_generation_replacement_prerequisite_drift: %',spec[1];end if;
 end loop;
end $baseline$;

create function pg_temp.generation_replacement_patch(sig text,needle text,addition text,expected_count integer default 1)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare d text;
begin
 d:=pg_get_functiondef(to_regprocedure(sig));
 if d is null or length(needle)=0 or expected_count not in(1,2)
  or(length(d)-length(replace(d,needle,'')))/length(needle)<>expected_count
  then raise exception 'retail_generation_replacement_patch_drift: %',sig;end if;
 execute replace(d,needle,addition);
end $$;
create function pg_temp.generation_replacement_repin(sig text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare p record;h text;old_pin text;
begin
 select * into strict p from pg_proc where oid=to_regprocedure(sig);
 if(select count(*) from regexp_matches(p.prosrc,'self_pin text:=''SELF_MD5:[a-f0-9]{32}''','g'))<>1
  then raise exception 'retail_generation_replacement_self_pin_drift';end if;
 old_pin:=substring(p.prosrc from 'self_pin text:=''SELF_MD5:([a-f0-9]{32})''');
 h:=md5(regexp_replace(p.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'));
 execute replace(pg_get_functiondef(p.oid),'self_pin text:=''SELF_MD5:'||old_pin||'''','self_pin text:=''SELF_MD5:'||h||'''');
end $$;
revoke all on function pg_temp.generation_replacement_patch(text,text,text,integer),pg_temp.generation_replacement_repin(text)
 from public,anon,authenticated,service_role;

select pg_temp.generation_replacement_patch('private_retail_replacement.proof(uuid,uuid,text,jsonb)',
 $old$end_at:=public.retail_existing_month_anchor(paid,months);$old$,
 $new$end_at:=case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  and b->>'version'='retail_generation_initial_schedule_v1'
  then a.initial_renewal_date::timestamp at time zone 'UTC' else public.retail_existing_month_anchor(paid,months) end;$new$);
select pg_temp.generation_replacement_patch('private_retail_replacement.proof(uuid,uuid,text,jsonb)',
 $old$p_current->>'status' is distinct from 'active' or p_current->'current_period_end' is distinct from b->'provider_period_end'$old$,
 $new$p_current->>'status' is distinct from(case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
   and b->>'version'='retail_generation_initial_schedule_v1'
   then 'trialing' else 'active' end)
  or p_current->'current_period_end' is distinct from(case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
   and b->>'version'='retail_generation_initial_schedule_v1'
   then b->'provider_trial_end' else b->'provider_period_end' end)$new$);
select pg_temp.generation_replacement_patch('private_retail_replacement.proof(uuid,uuid,text,jsonb)',
 $old$to_timestamp((b->>'provider_period_end')::bigint)<=clock$old$,
 $new$to_timestamp((case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  and b->>'version'='retail_generation_initial_schedule_v1'
  then b->>'provider_trial_end' else b->>'provider_period_end' end)::bigint)<=clock$new$);

select pg_temp.generation_replacement_patch('private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)',
 $old$to_timestamp((b->>'provider_period_end')::bigint)<=clock$old$,
 $new$to_timestamp((case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  and b->>'version'='retail_generation_initial_schedule_v1'
  then b->>'provider_trial_end' else b->>'provider_period_end' end)::bigint)<=clock$new$);
select pg_temp.generation_replacement_patch('private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)',
 $old$public.retail_existing_month_anchor(p_a.checkout_paid_at,months)<=clock$old$,
 $new$(case when src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-15-v3'
  and b->>'version'='retail_generation_initial_schedule_v1'
  then p_a.initial_renewal_date::timestamp at time zone 'UTC' else public.retail_existing_month_anchor(p_a.checkout_paid_at,months) end)<=clock$new$);
select pg_temp.generation_replacement_repin('private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)');

-- Exact dependency DAG: proof -> private schema; owner-only billing proof ->
-- original public definer -> linked schema. Each normalized self pin last.
do $pins$
declare h text;
begin
 select md5(prosrc) into strict h from pg_proc where oid='private_retail_replacement.proof(uuid,uuid,text,jsonb)'::regprocedure;
 perform pg_temp.generation_replacement_patch('private_retail_replacement.schema_guard()',
  '2239f099a317152917531aaefd3667e9',h);
 perform pg_temp.generation_replacement_repin('private_retail_replacement.schema_guard()');
 select md5(prosrc) into strict h from pg_proc where oid='private_retail_replacement.billing_replacement_proof(public.membership_agreements,public.public_purchase_intents,public.clients,text,text,timestamptz)'::regprocedure;
 perform pg_temp.generation_replacement_patch('public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)',
  '478877d38d37f0d457baa1706e6430f4',h,2); -- first-write AND replay guard
 select md5(prosrc) into strict h from pg_proc where oid='public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)'::regprocedure;
 perform pg_temp.generation_replacement_patch('public.retail_linked_existing_member_schema_guard()',
  '33f40ea333ce482b363fa10fdf0ea5ff',h);
 perform pg_temp.generation_replacement_repin('public.retail_linked_existing_member_schema_guard()');
end $pins$;
-- Refuse any unreviewed caller retaining a replaced body fingerprint. Do not
-- broaden the DAG or delete a guard just to make a migration apply.
do $closed_callers$
declare h text;
begin
 foreach h in array array['2239f099a317152917531aaefd3667e9','478877d38d37f0d457baa1706e6430f4',
  '37fe432da3b8c33266c3eb267f280126','33f40ea333ce482b363fa10fdf0ea5ff','6ecfd1b5462f70f44c8f8648047a0324'] loop
  if exists(select 1 from pg_proc where position(h in prosrc)>0)
   then raise exception 'retail_generation_replacement_unreviewed_caller';end if;
 end loop;
end $closed_callers$;
set local role service_role;
select private_retail_replacement.schema_guard();
select private_retail_replacement.observation_schema_guard();
select private_retail_replacement.claim_schema_guard();
select public.retail_linked_existing_member_schema_guard();
reset role;
drop function pg_temp.generation_replacement_patch(text,text,text,integer),pg_temp.generation_replacement_repin(text);
commit;
