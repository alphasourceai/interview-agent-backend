-- LOCAL UNMOUNTED funding-only journal. NOT SDK authorization, cancellation,
-- billing completion, access, Auth or delivery. Original financial paths intact.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_namespace where nspname='private_retail_replacement')
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace
   and proname='reserve_retail_existing_replacement_cancel') then raise exception 'retail_replacement_schema_drift';end if;
 perform public.retail_linked_existing_member_schema_guard();
 if to_regprocedure('pg_catalog.sha256(bytea)') is null
  or not has_function_privilege('service_role','pg_catalog.sha256(bytea)','EXECUTE') then raise exception 'retail_replacement_hash_unavailable';end if;
 if to_regprocedure('pg_catalog.pg_advisory_xact_lock(integer,integer)') is null
  or to_regprocedure('pg_catalog.hashtext(text)') is null
  or not has_function_privilege('service_role','pg_catalog.pg_advisory_xact_lock(integer,integer)','EXECUTE')
  or not has_function_privilege('service_role','pg_catalog.hashtext(text)','EXECUTE')
  then raise exception 'retail_replacement_lock_unavailable';end if;
end $baseline$;
create schema private_retail_replacement;
revoke all on schema private_retail_replacement from public,anon,authenticated;
grant usage on schema private_retail_replacement to service_role;
create table private_retail_replacement.reservations(
 agreement_id uuid primary key references public.membership_agreements(id) on delete restrict,
 request jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 constraint finite_created check(isfinite(created_at)),
 constraint object_request check(jsonb_typeof(request)='object')
);
alter table private_retail_replacement.reservations enable row level security;
revoke all on private_retail_replacement.reservations from public,anon,authenticated,service_role;
grant select,insert on private_retail_replacement.reservations to service_role;

create function private_retail_replacement.schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p record;s text[];self_pin text:='SELF_MD5:00000000000000000000000000000000';
begin
 perform public.retail_linked_existing_member_schema_guard();
 if not exists(select 1 from pg_class where oid='private_retail_replacement.reservations'::regclass
   and relkind='r' and relrowsecurity and relowner=(select oid from pg_roles where rolname='postgres'))
  or(select count(*) from pg_attribute where attrelid='private_retail_replacement.reservations'::regclass and attnum>0 and not attisdropped)<>3
  or exists(select 1 from pg_attribute where attrelid='private_retail_replacement.reservations'::regclass and attnum>0 and not attisdropped
   and(not attnotnull or(attname='agreement_id' and atttypid<>'uuid'::regtype)
    or(attname='request' and atttypid<>'jsonb'::regtype) or(attname='created_at' and atttypid<>'timestamptz'::regtype)
    or attname not in('agreement_id','request','created_at')))
  or(select count(*) from pg_attrdef where adrelid='private_retail_replacement.reservations'::regclass)<>1
  or not exists(select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
   where d.adrelid='private_retail_replacement.reservations'::regclass and a.attname='created_at' and pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()')
  or exists(select 1 from pg_policy where polrelid='private_retail_replacement.reservations'::regclass)
  or(select count(*) from pg_constraint where conrelid='private_retail_replacement.reservations'::regclass)<>4
  or(select md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) from pg_constraint
   where conrelid='private_retail_replacement.reservations'::regclass) is distinct from 'CONSTRAINT_MD5'
  or exists(select 1 from pg_constraint where conrelid='private_retail_replacement.reservations'::regclass and not convalidated)
  or(select count(*) from pg_index where indrelid='private_retail_replacement.reservations'::regclass)<>1
  or not exists(select 1 from pg_index ix join pg_class idx on idx.oid=ix.indexrelid join pg_am am on am.oid=idx.relam
   join pg_opclass op on op.oid=ix.indclass[0] join pg_namespace ns on ns.oid=op.opcnamespace
   where ix.indrelid='private_retail_replacement.reservations'::regclass and am.amname='btree' and ns.nspname='pg_catalog'
    and op.opcname='uuid_ops' and ix.indisunique and ix.indisvalid and ix.indisready and ix.indislive and ix.indimmediate
    and ix.indnkeyatts=1 and ix.indnatts=1 and ix.indkey[0]=1 and ix.indpred is null and ix.indexprs is null)
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.reservations'::regclass and contype='p' and conkey=array[1]::smallint[])
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.reservations'::regclass and contype='f'
   and conkey=array[1]::smallint[] and confrelid='public.membership_agreements'::regclass and confdeltype='r')
  or not has_table_privilege('service_role','private_retail_replacement.reservations','SELECT')
  or not has_table_privilege('service_role','private_retail_replacement.reservations','INSERT')
  or not has_schema_privilege('service_role','private_retail_replacement','USAGE')
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   where c.oid='private_retail_replacement.reservations'::regclass
    and(x.grantee not in(c.relowner,(select oid from pg_roles where rolname='service_role'))
      or(x.grantee=(select oid from pg_roles where rolname='service_role') and x.privilege_type not in('SELECT','INSERT'))))
  or exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x
   where n.nspname='private_retail_replacement' and(x.grantee not in(n.nspowner,(select oid from pg_roles where rolname='service_role'))
    or(x.grantee=(select oid from pg_roles where rolname='service_role') and x.privilege_type<>'USAGE')))
  or(select count(*) from pg_trigger where tgrelid='private_retail_replacement.reservations'::regclass and not tgisinternal)<>1
  or not exists(select 1 from pg_trigger where tgrelid='private_retail_replacement.reservations'::regclass
   and tgname='immutable_reservation' and tgfoid='private_retail_replacement.guard()'::regprocedure and tgtype=31 and tgenabled='O' and not tgisinternal)
  then raise exception 'retail_replacement_schema_drift';end if;
 foreach s slice 1 in array array[
  array['private_retail_replacement.proof(uuid,uuid,text,jsonb)','PROOF_MD5'],
  array['private_retail_replacement.guard()','GUARD_MD5'],
  array['public.reserve_retail_existing_replacement_cancel(uuid,uuid,text,jsonb)','RESERVE_MD5']] loop
  select * into p from pg_proc where oid=to_regprocedure(s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.proisstrict or p.provolatile<>'v'
   or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   or(select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)<>1
   then raise exception 'retail_replacement_function_drift';end if;
 end loop;
 select * into p from pg_proc where oid='private_retail_replacement.schema_guard()'::regprocedure;
 if md5(regexp_replace(p.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
  is distinct from substring(self_pin from 10) or p.prosecdef or p.provolatile<>'s' or p.proisstrict
  or p.proconfig is distinct from array['search_path=pg_catalog']
  or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
   where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'retail_replacement_function_drift';end if;
end $$;

-- NO LOCKS. Main RPC already holds upstream locks. The INSERT guard reuses this
-- nonlocking source/clock proof, never calls the locking funding reader.
create function private_retail_replacement.proof(p_agreement uuid,p_intent uuid,p_claim text,p_current jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;i public.public_purchase_intents;c public.clients;
 src jsonb;w jsonb;b jsonb;material jsonb;clock timestamptz;paid timestamptz;months integer;n integer;old_id text;end_at timestamptz;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' then raise exception 'retail_replacement_server_only';end if;
 perform private_retail_replacement.schema_guard();
 select count(*) into n from public.public_purchase_intents where agreement_id=p_agreement;
 if n>1 then raise exception 'retail_replacement_source_denied';end if;
 if n=1 then select * into i from public.public_purchase_intents where agreement_id=p_agreement;end if;
 select * into a from public.membership_agreements where id=p_agreement;
 select * into c from public.clients where id=a.client_id;
 src:=a.checkout_attempt_source;w:=a.retail_funding_receipt;b:=w->'proof'->'period';clock:=clock_timestamp();
 if a.id is null or c.id is null or a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or a.status is null or a.status not in('signed','active') or a.is_current is distinct from true
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null or a.voided_at is not null
  or not coalesce(public.retail_existing_funding_receipt_valid(w,src),false)
  or a.checkout_session_id is distinct from b->>'checkout_session_id'
  or b->>'api_version' is distinct from '2023-10-16'
  or c.parent_client_id is not null or c.archived_at is not null or c.stripe_customer_id is distinct from b->>'customer_id'
  or(select count(*) from public.billing_customers where stripe_customer_id=c.stripe_customer_id)<>1
  or not exists(select 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=c.id)
  or a.checkout_embedded is null or a.checkout_created_at is null or not isfinite(a.checkout_created_at) or a.checkout_created_at>clock
  or not coalesce(public.retail_existing_checkout_config_valid(src->'config'),false)
  then raise exception 'retail_replacement_source_denied';end if;
 paid:=(b->>'paid_at')::timestamptz;
 if paid>clock or(w->>'recorded_at')::timestamptz>clock then raise exception 'retail_replacement_clock_denied';end if;
 if n=1 then
  if p_intent is distinct from i.id or src->'intent'->>'id' is distinct from i.id::text
   or a.template_snapshot->>'source' is null or a.template_snapshot->>'source' not in('public_purchase_intent','sales_assisted')
   or i.protocol is distinct from 'fenced_v2' or i.client_id is distinct from a.client_id or i.canceled_at is not null
   or i.stripe_checkout_session_id is distinct from a.checkout_session_id
   or p_claim is null or length(p_claim)<32 or i.activation_claim_key is distinct from p_claim
   or i.activation_claimed_at is null or i.activation_claimed_at>clock or i.activation_claimed_at<clock-interval '5 minutes'
   then raise exception 'retail_replacement_claim_denied';end if;
 else
  if p_intent is not null or p_claim is not null or src->'intent' is distinct from 'null'::jsonb
   or coalesce(a.template_snapshot->>'source','admin')<>'admin'
   then raise exception 'retail_replacement_source_denied';end if;
 end if;
 if a.checkout_paid_at is null then
  if a.status is distinct from 'signed' or a.checkout_status is distinct from 'pending_payment'
   or(n=1 and(i.status is distinct from 'checkout_pending' or i.activated_at is not null))
   or(c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from a.replaces_stripe_subscription_id)
   then raise exception 'retail_replacement_source_denied';end if;
 else
  if a.checkout_paid_at is distinct from paid or a.checkout_status is distinct from 'paid'
   or(n=1 and(i.status is distinct from 'completed' or i.activated_at is distinct from paid))
   then raise exception 'retail_replacement_source_denied';end if;
 end if;
 material:=public.retail_existing_checkout_material(to_jsonb(a),case when n=1 then to_jsonb(i) else null end,c.stripe_customer_id);
 if material is distinct from src-'config' then raise exception 'retail_replacement_source_denied';end if;
 months:=(src->'template_snapshot'->'package_snapshot'->'membership_terms'->>'commitment_months')::integer;
 end_at:=public.retail_existing_month_anchor(paid,months);
 if not coalesce(public.retail_existing_closed_object(p_current,array['id','customer','status','current_period_end',
   'cancel_at_period_end','cancel_at','pause_collection']),false)
  or p_current->'id' is distinct from b->'subscription_id' or p_current->'customer' is distinct from b->'customer_id'
  or p_current->>'status' is distinct from 'active' or p_current->'current_period_end' is distinct from b->'provider_period_end'
  or p_current->'cancel_at_period_end' is distinct from 'false'::jsonb
  or p_current->'cancel_at' is distinct from 'null'::jsonb or p_current->'pause_collection' is distinct from 'null'::jsonb
  then raise exception 'retail_replacement_current_denied';end if;
 clock:=clock_timestamp();
 if to_timestamp((b->>'provider_period_end')::bigint)<=clock or end_at<=clock
  or(n=1 and(i.activation_claimed_at>clock or i.activation_claimed_at<clock-interval '5 minutes'))
  then raise exception 'retail_replacement_clock_denied';end if;
 old_id:=a.replaces_stripe_subscription_id;
 if old_id is null then
  if a.replacement_policy is not null or(c.stripe_subscription_id is not null and c.stripe_subscription_id is distinct from b->>'subscription_id')
   then raise exception 'retail_replacement_source_denied';end if;
  return null;
 end if;
 if old_id !~ '^sub_[A-Za-z0-9_]+$' or length(old_id)>255 or old_id=b->>'subscription_id'
  or a.replacement_policy is distinct from 'immediate_cancel'
  or c.stripe_subscription_id is null or c.stripe_subscription_id not in(old_id,b->>'subscription_id')
  then raise exception 'retail_replacement_source_denied';end if;
 return jsonb_build_object('version','retail_existing_replacement_cancel_v1','api_version',b->'api_version',
  'agreement_id',a.id,'client_id',c.id,'intent_id',i.id,
  -- PostgreSQL's builtin SHA256 avoids granting service_role access to the
  -- existing extensions schema. Hash native UTF8 jsonb text, not browser bytes.
  'source_digest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(src::text,'UTF8')),'hex'),
  'funding_receipt_digest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(w::text,'UTF8')),'hex'),
  'provider_account_id',w->'proof'->'provider_account_id','livemode',b->'livemode','customer_id',b->'customer_id',
  'old_subscription_id',old_id,'new_subscription_id',b->'subscription_id',
  'cancellation',jsonb_build_object('method','DELETE','path','/v1/subscriptions/'||old_id,
   'parameters',jsonb_build_object('invoice_now',false,'prorate',false),'policy',a.replacement_policy));
end $$;

create function private_retail_replacement.guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare writer jsonb;expected jsonb;
begin
 if TG_OP<>'INSERT' then raise exception 'retail_replacement_immutable';end if;
 if current_user<>'service_role' then raise exception 'retail_replacement_writer_denied';end if;
 writer:=nullif(current_setting('private_retail_replacement.writer',true),'')::jsonb;
 if writer is null or writer->>'agreement_id' is distinct from new.agreement_id::text then raise exception 'retail_replacement_writer_denied';end if;
 expected:=private_retail_replacement.proof(new.agreement_id,(writer->>'intent_id')::uuid,writer->>'claim',writer->'current');
 if expected is null or new.request is distinct from expected then raise exception 'retail_replacement_request_denied';end if;
 new.created_at:=clock_timestamp();return new;
end $$;
create trigger immutable_reservation before insert or update or delete on private_retail_replacement.reservations
 for each row execute function private_retail_replacement.guard();

create function public.reserve_retail_existing_replacement_cancel(p_agreement uuid,p_intent uuid,p_claim text,p_current jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare i public.public_purchase_intents;a public.membership_agreements;c public.clients;
 n integer:=0;checked jsonb;request_ jsonb;saved private_retail_replacement.reservations;prior_writer text;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' then raise exception 'retail_replacement_server_only';end if;
 perform private_retail_replacement.schema_guard();
 for i in select * from public.public_purchase_intents where agreement_id=p_agreement order by id for update loop n:=n+1;end loop;
 if n>1 then raise exception 'retail_replacement_source_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found then raise exception 'retail_replacement_source_denied';end if;
 select * into c from public.clients where id=a.client_id for update;
 if not found then raise exception 'retail_replacement_source_denied';end if;
 perform 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 perform 1 from public.client_plan_settings where client_id=c.id for share;
 -- Original funded read only AFTER every upstream lock; no billing/member call.
 checked:=public.read_retail_existing_funding(a.id,c.id,p_claim,a.checkout_attempt_source);
 if not coalesce(public.retail_existing_closed_object(checked,array['version','phase','receipt']),false)
  or checked->>'version' is distinct from 'retail_existing_funding_read_v1'
  or checked->>'phase' is null or checked->>'phase' not in('pending','paid')
  or checked->'receipt' is distinct from a.retail_funding_receipt then raise exception 'retail_replacement_source_denied';end if;
 request_:=private_retail_replacement.proof(p_agreement,p_intent,p_claim,p_current);
 -- Last lock is transaction-scoped and uses a dedicated two-int namespace.
 -- A hash collision only serializes callers; identity remains the UUID PK.
 -- No journal UPDATE privilege is granted or required for the plain read.
 perform pg_catalog.pg_advisory_xact_lock(1632842307,pg_catalog.hashtext(p_agreement::text));
 select * into saved from private_retail_replacement.reservations where agreement_id=p_agreement;
 -- Fresh nonlocking proof after the LAST lock wait, including matching replay.
 if private_retail_replacement.proof(p_agreement,p_intent,p_claim,p_current) is distinct from request_
  then raise exception 'retail_replacement_request_denied';end if;
 if request_ is null then
  if saved.agreement_id is not null then raise exception 'retail_replacement_request_denied';end if;
  return jsonb_build_object('status','no_replacement','request',null,'created_at',null);
 end if;
 if saved.agreement_id is not null then
  if saved.request is distinct from request_ then raise exception 'retail_replacement_request_denied';end if;
  return jsonb_build_object('status','existing','request',saved.request,'created_at',to_char(saved.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 end if;
 prior_writer:=current_setting('private_retail_replacement.writer',true);
 perform set_config('private_retail_replacement.writer',jsonb_build_object('agreement_id',p_agreement,'intent_id',p_intent,'claim',p_claim,'current',p_current)::text,true);
 begin
  insert into private_retail_replacement.reservations(agreement_id,request) values(p_agreement,request_) returning * into saved;
 exception when unique_violation then
  perform set_config('private_retail_replacement.writer',coalesce(prior_writer,''),true);
  select * into saved from private_retail_replacement.reservations where agreement_id=p_agreement;
  if saved.agreement_id is null or saved.request is distinct from private_retail_replacement.proof(p_agreement,p_intent,p_claim,p_current)
   then raise exception 'retail_replacement_request_denied';end if;
  return jsonb_build_object('status','existing','request',saved.request,'created_at',to_char(saved.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 end;
 perform set_config('private_retail_replacement.writer',coalesce(prior_writer,''),true);
 if saved.request is distinct from private_retail_replacement.proof(p_agreement,p_intent,p_claim,p_current)
  then raise exception 'retail_replacement_request_denied';end if;
 return jsonb_build_object('status','reserved','request',saved.request,'created_at',to_char(saved.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;
revoke all on function private_retail_replacement.schema_guard(),private_retail_replacement.proof(uuid,uuid,text,jsonb),
 private_retail_replacement.guard(),public.reserve_retail_existing_replacement_cancel(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function private_retail_replacement.schema_guard(),private_retail_replacement.proof(uuid,uuid,text,jsonb),
 private_retail_replacement.guard(),public.reserve_retail_existing_replacement_cancel(uuid,uuid,text,jsonb) to service_role;
do $pins$
declare p record;body text;digest text;sig text;token text;
begin
 -- pg_get_constraintdef qualifies FK names using search_path. Match the pinned
 -- runtime guard, not the migrator's default public path.
 perform set_config('search_path','pg_catalog',true);
 select * into p from pg_proc where oid='private_retail_replacement.schema_guard()'::regprocedure;body:=p.prosrc;
 select md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) into digest from pg_constraint
  where conrelid='private_retail_replacement.reservations'::regclass;
 body:=replace(body,'CONSTRAINT_MD5',digest);
 for sig,token in select * from(values
  ('private_retail_replacement.proof(uuid,uuid,text,jsonb)','PROOF_MD5'),
  ('private_retail_replacement.guard()','GUARD_MD5'),
  ('public.reserve_retail_existing_replacement_cancel(uuid,uuid,text,jsonb)','RESERVE_MD5'))v(signature,placeholder) loop
  select md5(prosrc) into digest from pg_proc where oid=to_regprocedure(sig);body:=replace(body,token,digest);
 end loop;
 digest:=md5(body);body:=replace(body,$needle$self_pin text:='SELF_MD5:00000000000000000000000000000000'$needle$,
  format('self_pin text:=%L','SELF_MD5:'||digest));
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
end $pins$;
select private_retail_replacement.schema_guard();
commit;
