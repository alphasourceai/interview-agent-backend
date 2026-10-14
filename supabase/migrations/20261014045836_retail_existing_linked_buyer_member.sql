-- LOCAL UNMOUNTED. Guard the original four-argument member writer; no Auth,
-- billing/plan/credit mutation or full-term/renewal entitlement is introduced.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('retail_linked_existing_member_schema_guard',
   'retail_linked_existing_member_context','retail_linked_existing_member_commit_guard',
   'ensure_retail_existing_linked_buyer_member'))
  or exists(select 1 from pg_trigger where tgrelid='public.client_members'::regclass
   and tgname='retail_linked_existing_member_commit_guard')
  then raise exception 'retail_linked_member_schema_drift';end if;
end $baseline$;

create function public.retail_linked_existing_member_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare spec text[];m record;self_pin text:='SELF_MD5:795876328da39f983480b73d8091897f';
begin
 -- Normalize only this self-checksum literal, avoiding circular body hashes.
 -- This is schema-drift detection, not a defense against hostile service DDL.
 select * into m from pg_proc where oid='public.retail_linked_existing_member_schema_guard()'::regprocedure;
 if md5(regexp_replace(m.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
   is distinct from substring(self_pin from 10)
  or m.prosecdef or m.proisstrict or m.provolatile<>'s' or m.proconfig is distinct from array['search_path=pg_catalog']
  or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',m.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
   where grantee not in(m.proowner,(select oid from pg_roles where rolname='service_role')))
  or(select count(*) from pg_proc p where p.pronamespace=m.pronamespace and p.proname=m.proname)<>1
  then raise exception 'retail_linked_member_prerequisite_drift';end if;
 -- The already-reviewed chain pins funding source/reader/offer/month helpers,
 -- existing table privileges, RLS, customer/plan PKs and original UUID sync.
 perform public.retail_admin_existing_member_schema_guard();
 foreach spec slice 1 in array array[
  array['public.retail_admin_existing_member_schema_guard()','5657bc667e754fb0db9ad9f0d8a9359b','s','invoker','catalog','service'],
  array['public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)','6ed48e7c15548a4521417b99ee213bd7','v','definer','empty','service'],
  array['public.ensure_public_purchase_buyer_member(uuid,text,uuid,text)','7db94104c90653a738e528424758b131','v','definer','empty','service'],
  array['private_sales.locked_purchase_context(uuid,text)','e0ce272430acdbf6584c471f5a7e5ce0','v','definer','empty','owner'],
  array['public.retail_existing_terms_months(jsonb,jsonb)','f9040629d7954ff583f68622d327ad2b','i','invoker','public','service']] loop
  if spec[6]='owner' then
   -- to_regprocedure on a private schema requires USAGE. Read the public
   -- catalog instead; do not grant schema/function access to service_role.
   select p.* into m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private_sales' and p.proname='locked_purchase_context'
     and p.proargtypes=array['uuid'::regtype::oid,'text'::regtype::oid]::oidvector;
  else select * into m from pg_proc where oid=to_regprocedure(spec[1]);end if;
  if not found or md5(m.prosrc) is distinct from spec[2] or m.proisstrict
   or m.provolatile::text<>spec[3] or m.prosecdef is distinct from(spec[4]='definer')
   or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or m.proconfig is distinct from(case spec[5] when 'empty' then array['search_path=""']
    when 'public' then array['search_path=pg_catalog, public'] else array['search_path=pg_catalog'] end)
   or(spec[6]='service' and not has_function_privilege('service_role',m.oid,'EXECUTE'))
   or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
    where grantee<>m.proowner and(spec[6]='owner' or grantee<>(select oid from pg_roles where rolname='service_role')))
   or(select count(*) from pg_proc p where p.pronamespace=m.pronamespace and p.proname=m.proname)<>1
   then raise exception 'retail_linked_member_prerequisite_drift';end if;
 end loop;
 -- Called once before creation, then always with all four functions present.
 if to_regprocedure('public.ensure_retail_existing_linked_buyer_member(uuid,text,text,jsonb,uuid,text)') is not null then
  foreach spec slice 1 in array array[
   array['retail_linked_existing_member_context(uuid,text,text,jsonb)','757cecae110bd8b907a8d9d861d039a0'],
   array['retail_linked_existing_member_commit_guard()','66e6d9e2bd5785c7ae792976018a70b2'],
   array['ensure_retail_existing_linked_buyer_member(uuid,text,text,jsonb,uuid,text)','84372f7772b9ff2a8dc96910a2f4179a']] loop
   select * into m from pg_proc where oid=to_regprocedure('public.'||spec[1]);
   if not found or md5(m.prosrc) is distinct from spec[2] or m.prosecdef or m.proisstrict or m.provolatile<>'v'
    or m.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
    or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
    or not has_function_privilege('service_role',m.oid,'EXECUTE')
    or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
     where grantee not in(m.proowner,(select oid from pg_roles where rolname='service_role')))
    or(select count(*) from pg_proc p where p.pronamespace=m.pronamespace and p.proname=m.proname)<>1
    then raise exception 'retail_linked_member_prerequisite_drift';end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.client_members'::regclass
   and tgname='retail_linked_existing_member_commit_guard' and tgtype=21 and tgenabled='O'
   and not tgisinternal and tgdeferrable and tginitdeferred
   and tgfoid='public.retail_linked_existing_member_commit_guard()'::regprocedure)
   then raise exception 'retail_linked_member_trigger_drift';end if;
 end if;
end $$;
revoke all on function public.retail_linked_existing_member_schema_guard() from public,anon,authenticated;
grant execute on function public.retail_linked_existing_member_schema_guard() to service_role;
select public.retail_linked_existing_member_schema_guard();

create function public.retail_linked_existing_member_context(p_intent uuid,p_claim text,p_digest text,p_current jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare i public.public_purchase_intents;a public.membership_agreements;c public.clients;
 replay jsonb;period jsonb;clock timestamptz;period_at timestamptz;end_at timestamptz;months integer;
begin
 if current_user<>'service_role' then raise exception 'retail_linked_member_server_only';end if;
 perform public.retail_linked_existing_member_schema_guard();
 -- UPDATE before the old reader's SHARE locks: no lock upgrade/inversion.
 select * into i from public.public_purchase_intents where id=p_intent for update;
 if not found or i.protocol is distinct from 'fenced_v2' or i.status is distinct from 'completed'
  or i.canceled_at is not null or i.agreement_id is null or i.client_id is null
  then raise exception 'retail_linked_member_source_denied';end if;
 select * into a from public.membership_agreements where id=i.agreement_id for update;
 if not found or a.client_id is distinct from i.client_id or a.status is distinct from 'signed'
  or a.template_version is distinct from 'membership_agreement_retail_terms_v2' or a.retail_funding_receipt is null
  or a.template_snapshot->>'source' is null or a.template_snapshot->>'source' not in('public_purchase_intent','sales_assisted')
  or a.is_current is distinct from true or a.checkout_status is distinct from 'paid'
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.voided_at is not null
  then raise exception 'retail_linked_member_source_denied';end if;
 select * into c from public.clients where id=i.client_id for update;
 if not found then raise exception 'retail_linked_member_source_denied';end if;
 perform 1 from public.billing_customers where stripe_customer_id=a.checkout_attempt_source->>'customer_id' order by id for share;
 perform 1 from public.client_plan_settings where client_id=c.id for share;
 if not found then raise exception 'retail_linked_member_plan_missing';end if;
 replay:=public.read_retail_existing_funding(a.id,c.id,p_claim,a.checkout_attempt_source);
 if not coalesce(public.retail_existing_closed_object(replay,array['version','phase','receipt']),false)
  or replay->>'version' is distinct from 'retail_existing_funding_read_v1' or replay->>'phase' is distinct from 'paid'
  or replay->'receipt' is distinct from a.retail_funding_receipt
  then raise exception 'retail_linked_member_receipt_denied';end if;
 period:=a.retail_funding_receipt->'proof'->'period';
 months:=public.retail_existing_terms_months(to_jsonb(a),to_jsonb(i));
 if months is null or months not in(3,6,12) then raise exception 'retail_linked_member_source_denied';end if;
 end_at:=public.retail_existing_month_anchor(a.checkout_paid_at,months);
 period_at:=to_timestamp((period->>'provider_period_end')::bigint);
 if not coalesce(public.retail_existing_closed_object(p_current,array['id','customer','status','current_period_end',
  'cancel_at_period_end','cancel_at','pause_collection']),false)
  or p_current->'id' is distinct from period->'subscription_id' or p_current->'customer' is distinct from period->'customer_id'
  or p_current->>'status' is distinct from 'active' or p_current->'current_period_end' is distinct from period->'provider_period_end'
  or jsonb_typeof(p_current->'cancel_at_period_end') is distinct from 'boolean'
  or not(case when p_current->'cancel_at'='null'::jsonb then true
   when jsonb_typeof(p_current->'cancel_at')='number' and p_current->>'cancel_at' ~ '^[0-9]+$'
    then(p_current->>'cancel_at')::numeric between(period->>'provider_period_end')::numeric and 253402300799
   else false end)
  or p_current->'pause_collection' is distinct from 'null'::jsonb
  then raise exception 'retail_linked_member_current_subscription_denied';end if;
 if c.stripe_subscription_id is distinct from period->>'subscription_id'
  or c.billing_status is distinct from 'active' or c.subscription_status is distinct from 'active'
  or c.current_term_end is distinct from period_at or c.contract_start_at is distinct from a.checkout_paid_at
  or c.contract_end_at is distinct from end_at or c.access_override_mode is null
  or c.access_override_mode not in('inherit','force_active')
  then raise exception 'retail_linked_member_current_access_denied';end if;
 -- Fresh AFTER all source/profile/plan waits; also invoked after member waits
 -- and at actual COMMIT. The digest is compared, never recomputed from fees.
 clock:=clock_timestamp();
 if p_claim is null or length(p_claim)<32 or i.activation_claim_key is distinct from p_claim
  or i.activation_claimed_at is null or i.activation_claimed_at>clock or i.activation_claimed_at<clock-interval '5 minutes'
  then raise exception 'retail_linked_member_claim_denied';end if;
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or i.billing_apply_digest is distinct from p_digest
  or i.billing_applied_at is null or not isfinite(i.billing_applied_at) or i.billing_applied_at>clock
  then raise exception 'retail_linked_member_billing_denied';end if;
 if period_at<=clock or end_at<=clock then raise exception 'retail_linked_member_paid_period_ended';end if;
 return jsonb_build_object('intent_id',i.id,'agreement_id',a.id,'client_id',c.id,'claim',p_claim,'digest',p_digest,
  'billing_applied_at',i.billing_applied_at,'source',a.checkout_attempt_source,'receipt',a.retail_funding_receipt,
  'current',p_current,'buyer_email',lower(btrim(i.buyer_email)));
end $$;

create function public.retail_linked_existing_member_commit_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare binding jsonb;context jsonb;r public.client_members;matches integer;
begin
 binding:=coalesce(nullif(current_setting('private_sales.retail_linked_member_contexts',true),''),'{}')::jsonb
  ->(new.client_id::text||':'||new.user_id::text);
 if binding is null then return null;end if;
 -- Immediate execution in the original DEFINER must fail, not elevate the
 -- guard or accept an incomplete role. Normal deferred execution is service.
 if current_user<>'service_role' or binding->>'role' is null or binding->>'role'=''
  or binding->>'user_id' is distinct from new.user_id::text then raise exception 'retail_linked_member_commit_binding_denied';end if;
 context:=public.retail_linked_existing_member_context((binding->>'intent_id')::uuid,binding->>'claim',binding->>'digest',binding->'current');
 if context is distinct from binding-array['user_id','role'] then raise exception 'retail_linked_member_commit_binding_denied';end if;
 matches:=0;
 for r in select * from public.client_members where client_id=new.client_id
  and(user_id=new.user_id or lower(btrim(email))=context->>'buyer_email') order by client_id,user_id for update
  loop matches:=matches+1;end loop;
 if matches<>1 or r.user_id is distinct from new.user_id or r.user_id_uuid is distinct from new.user_id
  or r.client_id is distinct from new.client_id or lower(btrim(r.email)) is distinct from context->>'buyer_email'
  or r.role is distinct from binding->>'role' then raise exception 'retail_linked_member_commit_identity_denied';end if;
 -- Do not reuse the pre-member-lock clock at the commit boundary.
 if public.retail_linked_existing_member_context((binding->>'intent_id')::uuid,binding->>'claim',binding->>'digest',binding->'current')
  is distinct from context then raise exception 'retail_linked_member_commit_binding_denied';end if;
 return null;
end $$;
create constraint trigger retail_linked_existing_member_commit_guard after insert or update on public.client_members
 deferrable initially deferred for each row execute function public.retail_linked_existing_member_commit_guard();

create function public.ensure_retail_existing_linked_buyer_member(p_intent uuid,p_claim text,p_digest text,p_current jsonb,p_user uuid,p_name text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare context jsonb;fresh jsonb;ack jsonb;r public.client_members;matches integer;client uuid;buyer text;key text;binding jsonb;contexts jsonb;
begin
 if p_user is null or p_user='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'retail_linked_member_user_denied';end if;
 context:=public.retail_linked_existing_member_context(p_intent,p_claim,p_digest,p_current);
 client:=(context->>'client_id')::uuid;buyer:=context->>'buyer_email';
 if buyer is null or buyer='' then raise exception 'retail_linked_member_buyer_denied';end if;
 matches:=0;
 for r in select * from public.client_members where client_id=client and(user_id=p_user or lower(btrim(email))=buyer)
  order by client_id,user_id for update loop matches:=matches+1;end loop;
 if matches>1 or(matches=1 and(r.user_id is distinct from p_user
  or(nullif(btrim(r.email),'') is not null and lower(btrim(r.email)) is distinct from buyer)))
  then raise exception 'retail_linked_member_identity_conflict';end if;
 key:=client::text||':'||p_user::text;binding:=context||jsonb_build_object('user_id',p_user);
 contexts:=coalesce(nullif(current_setting('private_sales.retail_linked_member_contexts',true),''),'{}')::jsonb;
 if contexts?key and (contexts->key)-'role' is distinct from binding then raise exception 'retail_linked_member_binding_conflict';end if;
 -- Mark before the original mutation. No expected-role placeholder is valid.
 perform set_config('private_sales.retail_linked_member_contexts',jsonb_set(contexts,array[key],binding)::text,true);
 fresh:=public.retail_linked_existing_member_context(p_intent,p_claim,p_digest,p_current);
 if fresh is distinct from context then raise exception 'retail_linked_member_binding_conflict';end if;
 -- The SAME original routine owns INSERT/UPDATE, normalization and PK adoption.
 ack:=public.ensure_public_purchase_buyer_member(p_intent,p_claim,p_user,p_name);
 if not coalesce(public.retail_existing_closed_object(ack,array['status','role']),false)
  or ack->>'status' is null or ack->>'status' not in('created','existing','updated')
  or ack->>'role' is null or ack->>'role'='' then raise exception 'retail_linked_member_original_ack_denied';end if;
 matches:=0;
 for r in select * from public.client_members where client_id=client and(user_id=p_user or lower(btrim(email))=buyer)
  order by client_id,user_id for update loop matches:=matches+1;end loop;
 if matches<>1 or r.user_id is distinct from p_user or r.user_id_uuid is distinct from p_user
  or lower(btrim(r.email)) is distinct from buyer or r.role is distinct from ack->>'role'
  then raise exception 'retail_linked_member_identity_conflict';end if;
 fresh:=public.retail_linked_existing_member_context(p_intent,p_claim,p_digest,p_current);
 if fresh is distinct from context then raise exception 'retail_linked_member_binding_conflict';end if;
 binding:=binding||jsonb_build_object('role',ack->>'role');
 contexts:=coalesce(nullif(current_setting('private_sales.retail_linked_member_contexts',true),''),'{}')::jsonb;
 perform set_config('private_sales.retail_linked_member_contexts',jsonb_set(contexts,array[key],binding)::text,true);
 return ack;
end $$;
revoke all on function public.retail_linked_existing_member_context(uuid,text,text,jsonb),
 public.retail_linked_existing_member_commit_guard(),public.ensure_retail_existing_linked_buyer_member(uuid,text,text,jsonb,uuid,text)
 from public,anon,authenticated;
grant execute on function public.retail_linked_existing_member_context(uuid,text,text,jsonb),
 public.retail_linked_existing_member_commit_guard(),public.ensure_retail_existing_linked_buyer_member(uuid,text,text,jsonb,uuid,text) to service_role;
commit;
