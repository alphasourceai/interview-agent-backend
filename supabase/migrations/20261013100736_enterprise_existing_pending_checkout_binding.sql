-- Pending-only existing-row binding. LOCAL, no SDK/Auth/settlement or backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record; t record;
begin
 foreach spec slice 1 in array array[
  array['enterprise_pool_v2_valid_offer(jsonb)','8aff4ac3cfc7190cf5ac9eb86c7f5db1'],
  array['enterprise_pool_v2_canonical(jsonb)','87b6c10158002e10bdb2f02d44219e2a'],
  array['enterprise_pool_v2_offer_digest(jsonb)','47c728590c8c473315afc11ae5070706'],
  array['enterprise_pool_v2_guard_pool()','5ec10701ca59c0c9fd6735a6f644c1a0'],
  array['enterprise_pool_v2_guard_agreement()','f556d965930467187ec3b4de8ee11542'],
  array['enterprise_pool_v2_guard_source()','483cc416ab9ee7e3017f3ee8d0490daa'],
  array['enterprise_pool_v2_guard_pending_insert()','9df07c756380812c8664483c10d391f0'],
  array['enterprise_v2_execution_seal_guard()','553db3bf2bbe63761d723029e9696340'],
  array['enterprise_v2_execution_sign()','63c242085d7d98d025448ec14280e6c0'],
  array['enterprise_v2_signing_requires_seal()','eb87e1661cf367050af8a859340ded6e'],
  array['complete_membership_agreement_signing(uuid,timestamp with time zone,timestamp with time zone,text,text,text,text,text,text,jsonb)','9d983930fe71739332508043a09994d8']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or p.prosecdef or md5(p.prosrc)<>spec[2] or p.proconfig is distinct from array['search_path=pg_catalog']
   or(spec[1] not like 'complete_membership_agreement_signing(%' and
    (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')))
   or not has_function_privilege('service_role',p.oid,'EXECUTE') then raise exception 'enterprise_binding_prerequisite_drift';end if;
 end loop;
 for t in select x.tab,x.name,x.kind from (values
  ('client_interview_pools','enterprise_pool_v2_guard_pool',31),('client_interview_pools','enterprise_pool_v2_guard_pending_insert',7),
  ('membership_agreements','enterprise_pool_v2_guard_agreement',23),('membership_agreements','enterprise_pool_v2_guard_source',27),
  ('membership_agreements','enterprise_v2_signing_requires_seal',19),('enterprise_v2_execution_seals','enterprise_v2_execution_seal_guard',31),
  ('enterprise_v2_execution_seals','enterprise_v2_execution_sign',5)) x(tab,name,kind) loop
  if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||t.tab) and tgname=t.name and tgenabled='O'
   and tgtype=t.kind and tgfoid=to_regprocedure('public.'||t.name||'()')) then raise exception 'enterprise_binding_trigger_drift';end if;
 end loop;
 if exists(select 1 from pg_attribute where not attisdropped and
  ((attrelid='public.membership_agreements'::regclass and attname in('enterprise_checkout_source','enterprise_checkout_pool_id'))
   or(attrelid='public.client_interview_pools'::regclass and attname='agreement_id')))
  or not exists(select 1 from pg_class where oid='public.client_interview_pools'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.enterprise_v2_execution_seals'::regclass and relrowsecurity)
  or exists(select 1 from pg_policies where schemaname='public' and tablename in('client_interview_pools','enterprise_v2_execution_seals'))
  or has_table_privilege('anon','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.client_interview_pools','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','public.enterprise_v2_execution_seals','SELECT,INSERT,UPDATE,DELETE')
  or not has_table_privilege('service_role','public.enterprise_v2_execution_seals','SELECT,INSERT')
  or has_table_privilege('service_role','public.enterprise_v2_execution_seals','UPDATE,DELETE,TRUNCATE') then raise exception 'enterprise_binding_schema_acl_drift';end if;
 foreach spec slice 1 in array array[
  array['enterprise_pool_v2_snapshot_check','207ca2f1615bd52298ca296c582563b6'],
  array['client_interview_pools_total_check','11bf823dae61f175be0a7acf76bacaed'],
  array['client_interview_pools_status_check','6bb064e6f03e464e7a80304b9eaa163a'],
  array['client_interview_pools_discount_check','d6a426fad89ecefcae48770cd15ca656'],
  array['client_interview_pools_quantity_check','70a754901507cc93dbc7d569ab5ac563'],
  array['client_interview_pools_unit_price_check','f611d5276579a2181341465e4b9bce18']] loop
  if not exists(select 1 from pg_constraint where conrelid='public.client_interview_pools'::regclass
   and conname=spec[1] and contype='c' and convalidated and md5(pg_get_constraintdef(oid))=spec[2]) then raise exception 'enterprise_binding_check_drift';end if;
 end loop;
 for t in select x.tab,x.name,x.type,x.required from (values
  ('client_interview_pools','id','uuid',true),('client_interview_pools','client_id','uuid',true),
  ('client_interview_pools','quantity_purchased','integer',true),('client_interview_pools','unit_price_cents','integer',true),
  ('client_interview_pools','discount_pct','numeric',true),('client_interview_pools','total_cents','integer',true),
  ('client_interview_pools','status','text',true),('client_interview_pools','created_at','timestamptz',true),
  ('client_interview_pools','paid_at','timestamptz',false),('client_interview_pools','offer_snapshot','jsonb',false),
  ('client_interview_pools','offer_digest','text',false),('client_interview_pools','stripe_checkout_session_id','text',false),
  ('client_interview_pools','stripe_payment_intent_id','text',false),('enterprise_v2_execution_seals','agreement_id','uuid',true),
  ('enterprise_v2_execution_seals','attempt_id','uuid',true),('enterprise_v2_execution_seals','token_hash','text',true),
  ('enterprise_v2_execution_seals','source_snapshot','jsonb',true),('enterprise_v2_execution_seals','execution','jsonb',true),
  ('enterprise_v2_execution_seals','signed_at','timestamptz',true),('enterprise_v2_execution_seals','recorded_at','timestamptz',true),
  ('membership_agreements','checkout_created_at','timestamptz',false),('membership_agreements','checkout_session_id','text',false),
  ('membership_agreements','checkout_paid_at','timestamptz',false),('membership_agreements','checkout_status','text',false),
  ('membership_agreements','checkout_attempt_source','jsonb',false),('membership_agreements','checkout_embedded','boolean',false),
  ('membership_agreements','replaces_stripe_subscription_id','text',false),('membership_agreements','replacement_policy','text',false)
 )x(tab,name,type,required) loop
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||t.tab) and attname=t.name
   and atttypid=to_regtype(t.type) and attnotnull=t.required and not attisdropped) then raise exception 'enterprise_binding_column_drift';end if;
 end loop;
end $baseline$;
alter table public.membership_agreements add column enterprise_checkout_source jsonb,
 add column enterprise_checkout_pool_id uuid references public.client_interview_pools(id) on delete restrict;
alter table public.client_interview_pools add column agreement_id uuid references public.membership_agreements(id) on delete restrict;
create unique index enterprise_pool_one_initial_agreement on public.client_interview_pools(agreement_id) where agreement_id is not null;

create function public.enterprise_existing_pending_material(a jsonb,c jsonb,s jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare v jsonb:=a->'template_snapshot'->'values'; e jsonb:=s->'execution'; o jsonb:=v->'pool_offer_snapshot';
 field text; n numeric; signed_time timestamptz; deadline timestamptz; duration text; questions text;
begin
 if a->>'client_id' is null or a->>'client_id' is distinct from c->>'id' or c->>'parent_client_id' is not null or c->>'archived_at' is not null
  or coalesce(c->>'stripe_customer_id','') !~ '^cus_[A-Za-z0-9_]+$'
  or a->>'membership_tier' is distinct from 'enterprise' or v->>'membership_tier' is distinct from 'enterprise'
  or v->>'billing_model' is distinct from 'usage' or a->>'billing_option' not in('monthly','annual')
  or v->>'billing_option' is distinct from a->>'billing_option' or a->'signer_accepted' is distinct from 'true'::jsonb
  or not public.enterprise_pool_v2_valid_offer(o) or(o->>'net_cents')::numeric<=0
  or v->>'pool_offer_digest' is distinct from public.enterprise_pool_v2_offer_digest(o) or v->'pool_discount_priced' is distinct from 'true'::jsonb
  or s->>'agreement_id' is distinct from a->>'id' or s->>'token_hash' is distinct from a->>'signer_token_hash'
  or s->'source_snapshot' is distinct from((a->'template_snapshot')-'execution') or e is distinct from a->'template_snapshot'->'execution'
  or e->>'attempt_id' is distinct from s->>'attempt_id' or e->>'version' is distinct from 'enterprise_execution_v2' then raise exception 'enterprise_binding_source_denied';end if;
 foreach field in array array['signer_typed_name','signature_image_path','signature_sha256','executed_pdf_path','signer_ip','signer_user_agent'] loop
  if a->field is distinct from e->field then raise exception 'enterprise_binding_seal_denied';end if;
 end loop;
 signed_time:=(a->>'signed_at')::timestamptz;deadline:=(a->>'agreement_expires_at')::timestamptz;
 if not coalesce(isfinite(signed_time),false) or signed_time is distinct from(s->>'signed_at')::timestamptz
  or signed_time is distinct from(e->>'signed_at')::timestamptz or not coalesce(isfinite(deadline),false)
  or octet_length((a->'template_snapshot')::text)>1048576 then raise exception 'enterprise_binding_seal_denied';end if;
 foreach field in array array['platform_fee','per_role_fee','additional_interview_fee','included_interviews_per_role','pool_quantity','usage_interview_fee_cents','pool_discount_pct','pool_total_cents'] loop
  if jsonb_typeof(v->field) not in('number','string') or coalesce(v->>field,'') !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'enterprise_binding_settings_denied';end if;
  n:=(v->>field)::numeric;
  if n>2147483647 or(field='platform_fee' and(n<=0 or n*100>2147483647)) then raise exception 'enterprise_binding_settings_denied';end if;
 end loop;
 if(v->>'per_role_fee')::numeric<>0 or(v->>'additional_interview_fee')::numeric<>0 or(v->>'included_interviews_per_role')::numeric<>0
  or(v->>'pool_quantity')::numeric<>(o->>'quantity')::numeric or(v->>'usage_interview_fee_cents')::numeric<>(o->>'unit_price_cents')::numeric
  or(v->>'pool_discount_pct')::numeric<>(o->>'automatic_discount_percent')::numeric or(v->>'pool_total_cents')::numeric<>(o->>'net_cents')::numeric
  or nullif(btrim(v->>'rollover_days'),'') is not null then raise exception 'enterprise_binding_settings_denied';end if;
 duration:=nullif(btrim(v->>'max_interview_minutes'),'');questions:=nullif(btrim(v->>'scored_question_count'),'');
 if(duration is null)<>(questions is null) then raise exception 'enterprise_binding_settings_denied';end if;
 if duration is not null and(duration !~ '^[0-9]+$' or questions !~ '^[0-9]+$' or duration::numeric not between 5 and 59
  or questions::numeric not between 1 and 7) then raise exception 'enterprise_binding_settings_denied';end if;
 return jsonb_build_object('agreement_id',a->'id','client_id',a->'client_id','customer_id',c->'stripe_customer_id',
  'template_snapshot',a->'template_snapshot','template_version',a->'template_version','membership_tier',a->'membership_tier',
  'billing_option',a->'billing_option','auto_renew',a->'auto_renew','signer_token_hash',a->'signer_token_hash',
  'agreement_expires_at',to_char(deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'execution_seal',s);
end $$;
create function public.enterprise_existing_pending_config_valid(c jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $$
 select case when jsonb_typeof(c)='object' then(select count(*) from jsonb_object_keys(c))=2 and c ?& array['public_backend_base','public_sign_base']
  and jsonb_typeof(c->'public_backend_base')='string' and jsonb_typeof(c->'public_sign_base')='string'
  and length(c->>'public_backend_base') between 1 and 2048 and length(c->>'public_sign_base') between 1 and 2048
  and c->>'public_backend_base' ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]+)?$'
  and c->>'public_sign_base' ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]+)?$' else false end
$$;
create function public.enterprise_existing_pending_expiry(b timestamptz,legal_deadline timestamptz)
returns timestamptz language sql immutable security invoker set search_path=pg_catalog as $$
 select case when isfinite(b) and isfinite(legal_deadline) then
  least(legal_deadline,((date_trunc('month',b at time zone 'UTC')+interval '1 month') at time zone 'UTC')-interval '1 second',
   b+interval '24 hours'-interval '1 second') else null end
$$;
create function public.enterprise_existing_pending_agreement_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare src jsonb; b timestamptz; expires timestamptz; next_first timestamptz; material jsonb; c jsonb; s jsonb;
begin
 if TG_OP='DELETE' then if old.enterprise_checkout_source is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='INSERT' then
  if new.enterprise_checkout_source is not null or new.enterprise_checkout_pool_id is not null then raise exception 'enterprise_binding_claim_required';end if;return new;
 end if;
 if old.enterprise_checkout_source is not null then
  if new.enterprise_checkout_source is distinct from old.enterprise_checkout_source or new.enterprise_checkout_pool_id is distinct from old.enterprise_checkout_pool_id then raise exception 'enterprise_binding_immutable';end if;
 elsif new.enterprise_checkout_source is not null then
  if current_user<>'service_role' or old.checkout_created_at is not null or old.checkout_session_id is not null or old.enterprise_checkout_pool_id is not null then raise exception 'enterprise_binding_claim_required';end if;
 elsif new.enterprise_checkout_pool_id is not null then raise exception 'enterprise_binding_claim_required';else return new;end if;
 -- Leave existing retail/shared trace NULL in this pending-only slice.
 if new.checkout_created_at is not null or new.checkout_session_id is not null or new.checkout_attempt_source is not null
  or new.checkout_embedded is not null or new.replaces_stripe_subscription_id is not null or new.checkout_paid_at is not null
  or new.checkout_status is not null or new.replacement_policy is not null then raise exception 'enterprise_binding_pending_only';end if;
 src:=new.enterprise_checkout_source;
 if jsonb_typeof(src) is distinct from 'object' or(select count(*) from jsonb_object_keys(src))<>8
  or not(src ?& array['version','material','pool_id','created_at','expires_at','embedded','replacement_id','config'])
  or src->>'version' is distinct from 'enterprise_existing_pending_v1' or src->>'pool_id' is distinct from new.enterprise_checkout_pool_id::text
  or jsonb_typeof(src->'embedded') is distinct from 'boolean'
  or(src->'replacement_id'<>'null'::jsonb and(jsonb_typeof(src->'replacement_id')<>'string' or src->>'replacement_id' !~ '^sub_[A-Za-z0-9_]+$'))
  or not coalesce(public.enterprise_existing_pending_config_valid(src->'config'),false) then raise exception 'enterprise_binding_source_denied';end if;
 select to_jsonb(x) into c from public.clients x where id=new.client_id;
 select to_jsonb(x) into s from public.enterprise_v2_execution_seals x where agreement_id=new.id;
 material:=public.enterprise_existing_pending_material(to_jsonb(new),c,s);
 if material is distinct from src->'material' then raise exception 'enterprise_binding_source_denied';end if;
 b:=(src->>'created_at')::timestamptz;expires:=(src->>'expires_at')::timestamptz;
 next_first:=(date_trunc('month',b at time zone 'UTC')+interval '1 month') at time zone 'UTC';
 if not coalesce(isfinite(b),false) or src->>'created_at' is distinct from to_char(b at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  or not coalesce(isfinite(expires),false) or src->>'expires_at' is distinct from to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  or expires is distinct from public.enterprise_existing_pending_expiry(b,new.agreement_expires_at) then raise exception 'enterprise_binding_clock_denied';end if;
 if old.enterprise_checkout_source is null and(b>clock_timestamp() or b<clock_timestamp()-interval '10 seconds'
  or expires<clock_timestamp()+interval '30 minutes' or old.status is distinct from 'signed' or old.is_current is distinct from true
  or old.superseded_at is not null or old.superseded_by_agreement_id is not null
  or exists(select 1 from public.public_purchase_intents where agreement_id=new.id)) then raise exception 'enterprise_binding_claim_denied';end if;
 return new;
end $$;
create function public.enterprise_existing_pending_pool_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' then if old.agreement_id is not null then raise exception 'enterprise_binding_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if new.agreement_id is distinct from old.agreement_id then raise exception 'enterprise_binding_pool_link_immutable';end if;
  if new.agreement_id is null then return new;end if;
 elsif new.agreement_id is null then return new;end if;
 if current_user<>'service_role' or new.offer_snapshot is null or new.status is distinct from 'pending'
  or new.stripe_checkout_session_id is not null or new.stripe_payment_intent_id is not null or new.paid_at is not null then raise exception 'enterprise_binding_pending_only';end if;
 return new;
end $$;
create function public.enterprise_existing_pending_pair_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare aid uuid; a public.membership_agreements; p public.client_interview_pools;
begin
 if TG_TABLE_NAME='membership_agreements' then aid:=new.id;else aid:=new.agreement_id;end if;
 if aid is null then return null;end if;
 select * into a from public.membership_agreements where id=aid;
 select * into p from public.client_interview_pools where agreement_id=aid;
 if a.enterprise_checkout_source is null and a.enterprise_checkout_pool_id is null and p.agreement_id is null then return null;end if;
 if a.id is null or p.id is null or a.enterprise_checkout_pool_id is distinct from p.id
  or a.enterprise_checkout_source->>'pool_id' is distinct from p.id::text or a.client_id is distinct from p.client_id
  or p.offer_snapshot is distinct from a.template_snapshot->'values'->'pool_offer_snapshot'
  or p.offer_digest is distinct from a.template_snapshot->'values'->>'pool_offer_digest' then raise exception 'enterprise_binding_pair_denied';end if;
 return null;
end $$;
create trigger enterprise_existing_pending_agreement_guard before insert or update or delete on public.membership_agreements
 for each row execute function public.enterprise_existing_pending_agreement_guard();
create trigger enterprise_existing_pending_pool_guard before insert or update or delete on public.client_interview_pools
 for each row execute function public.enterprise_existing_pending_pool_guard();
create constraint trigger enterprise_existing_pending_agreement_pair after insert or update on public.membership_agreements
 deferrable initially deferred for each row execute function public.enterprise_existing_pending_pair_guard();
create constraint trigger enterprise_existing_pending_pool_pair after insert or update on public.client_interview_pools
 deferrable initially deferred for each row execute function public.enterprise_existing_pending_pair_guard();
create function public.claim_enterprise_existing_pending_checkout(p_agreement uuid,p_client uuid,p_expected_snapshot jsonb,
 p_customer text,p_embedded boolean,p_replacement text,p_config jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements; c public.clients; s public.enterprise_v2_execution_seals;
 parent uuid; material jsonb; src jsonb; b timestamptz; expires timestamptz; next_first timestamptz; pid uuid; o jsonb;
begin
 if current_user<>'service_role' or p_embedded is null or not coalesce(public.enterprise_existing_pending_config_valid(p_config),false)
  or(p_replacement is not null and p_replacement !~ '^sub_[A-Za-z0-9_]+$') then raise exception 'enterprise_binding_claim_denied';end if;
 select client_id into parent from public.membership_agreements where id=p_agreement;
 if parent is null or parent is distinct from p_client then raise exception 'enterprise_binding_parent_denied';end if;
 select * into c from public.clients where id=parent for update;
 if not found then raise exception 'enterprise_binding_parent_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from parent or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.checkout_status is not null or a.checkout_paid_at is not null
  or a.template_snapshot is distinct from p_expected_snapshot or c.stripe_customer_id is distinct from p_customer
  or exists(select 1 from public.public_purchase_intents where agreement_id=p_agreement) then raise exception 'enterprise_binding_claim_denied';end if;
 select * into s from public.enterprise_v2_execution_seals where agreement_id=p_agreement;
 if not found then raise exception 'enterprise_binding_seal_denied';end if;
 material:=public.enterprise_existing_pending_material(to_jsonb(a),to_jsonb(c),to_jsonb(s));
 if a.enterprise_checkout_source is not null then
  src:=a.enterprise_checkout_source;
  if src->'material' is distinct from material or src->'config' is distinct from p_config or src->'embedded' is distinct from to_jsonb(p_embedded)
   or(src->>'expires_at')::timestamptz<clock_timestamp()+interval '30 minutes'
   or(src->>'created_at')::timestamptz<=clock_timestamp()-interval '24 hours'+interval '1 second' then raise exception 'enterprise_binding_replay_denied';end if;
  perform 1 from public.client_interview_pools where id=a.enterprise_checkout_pool_id and agreement_id=a.id and client_id=c.id
   and status='pending' and paid_at is null and stripe_checkout_session_id is null and stripe_payment_intent_id is null
   and offer_snapshot=a.template_snapshot->'values'->'pool_offer_snapshot' and offer_digest=a.template_snapshot->'values'->>'pool_offer_digest';
  if not found then raise exception 'enterprise_binding_pair_denied';end if;return src;
 end if;
 if a.enterprise_checkout_pool_id is not null or a.checkout_created_at is not null or a.checkout_session_id is not null
  or a.checkout_attempt_source is not null or a.checkout_embedded is not null or a.replaces_stripe_subscription_id is not null
  or a.replacement_policy is not null then raise exception 'enterprise_binding_untracked_checkout';end if;
 b:=date_trunc('milliseconds',clock_timestamp());next_first:=(date_trunc('month',b at time zone 'UTC')+interval '1 month') at time zone 'UTC';
 expires:=public.enterprise_existing_pending_expiry(b,a.agreement_expires_at);
 if expires<clock_timestamp()+interval '30 minutes' then raise exception 'enterprise_binding_window_denied';end if;
 pid:=gen_random_uuid();o:=a.template_snapshot->'values'->'pool_offer_snapshot';
 src:=jsonb_build_object('version','enterprise_existing_pending_v1','material',material,'pool_id',pid,
  'created_at',to_char(b at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expires_at',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'embedded',p_embedded,'replacement_id',p_replacement,'config',p_config);
 insert into public.client_interview_pools(id,client_id,agreement_id,quantity_purchased,unit_price_cents,discount_pct,total_cents,
  offer_snapshot,offer_digest,status) values(pid,c.id,a.id,(o->>'quantity')::integer,(o->>'unit_price_cents')::integer,
  (o->>'automatic_discount_percent')::integer,(o->>'net_cents')::integer,o,a.template_snapshot->'values'->>'pool_offer_digest','pending');
 update public.membership_agreements set enterprise_checkout_source=src,enterprise_checkout_pool_id=pid where id=a.id;
 return src;
end $$;
revoke all on function public.enterprise_existing_pending_material(jsonb,jsonb,jsonb),public.enterprise_existing_pending_config_valid(jsonb),
 public.enterprise_existing_pending_expiry(timestamptz,timestamptz),
 public.enterprise_existing_pending_agreement_guard(),public.enterprise_existing_pending_pool_guard(),public.enterprise_existing_pending_pair_guard(),
 public.claim_enterprise_existing_pending_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.enterprise_existing_pending_material(jsonb,jsonb,jsonb),public.enterprise_existing_pending_config_valid(jsonb),
 public.enterprise_existing_pending_expiry(timestamptz,timestamptz),
 public.enterprise_existing_pending_agreement_guard(),public.enterprise_existing_pending_pool_guard(),public.enterprise_existing_pending_pair_guard(),
 public.claim_enterprise_existing_pending_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb) to service_role;
commit;
