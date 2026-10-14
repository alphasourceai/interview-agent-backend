-- LOCAL UNMOUNTED canceled-provider observation ONLY. Not SDK cancellation,
-- effect authorization, actor ownership, billing, funding, access or Auth.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 perform private_retail_replacement.schema_guard();
 if to_regclass('private_retail_replacement.cancellations') is not null
  or exists(select 1 from pg_proc where
   (pronamespace='private_retail_replacement'::regnamespace and proname in('observation_schema_guard','observation_proof','observation_guard'))
   or(pronamespace='public'::regnamespace and proname='record_retail_existing_replacement_canceled'))
  then raise exception 'retail_cancel_observation_schema_drift';end if;
 if not has_function_privilege('service_role','pg_catalog.pg_advisory_xact_lock(integer,integer)','EXECUTE')
  or not has_function_privilege('service_role','pg_catalog.hashtext(text)','EXECUTE') then raise exception 'retail_cancel_observation_lock_unavailable';end if;
end $baseline$;
create table private_retail_replacement.cancellations(
 agreement_id uuid primary key references private_retail_replacement.reservations(agreement_id) on delete restrict,
 observation jsonb not null,
 observed_at timestamptz not null default clock_timestamp(),
 constraint object_observation check(jsonb_typeof(observation)='object'),
 constraint finite_observed check(isfinite(observed_at))
);
alter table private_retail_replacement.cancellations enable row level security;
revoke all on private_retail_replacement.cancellations from public,anon,authenticated,service_role;
grant select,insert on private_retail_replacement.cancellations to service_role;

create function private_retail_replacement.observation_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p record;s text[];self_pin text:='SELF_MD5:00000000000000000000000000000000';
begin
 perform private_retail_replacement.schema_guard();
 if not exists(select 1 from pg_class where oid='private_retail_replacement.cancellations'::regclass and relkind='r'
   and relrowsecurity and relowner=(select oid from pg_roles where rolname='postgres'))
  or(select count(*) from pg_attribute where attrelid='private_retail_replacement.cancellations'::regclass and attnum>0 and not attisdropped)<>3
  or exists(select 1 from pg_attribute where attrelid='private_retail_replacement.cancellations'::regclass and attnum>0 and not attisdropped
   and(not attnotnull or(attname='agreement_id' and atttypid<>'uuid'::regtype) or(attname='observation' and atttypid<>'jsonb'::regtype)
    or(attname='observed_at' and atttypid<>'timestamptz'::regtype) or attname not in('agreement_id','observation','observed_at')))
  or(select count(*) from pg_attrdef where adrelid='private_retail_replacement.cancellations'::regclass)<>1
  or not exists(select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
   where d.adrelid='private_retail_replacement.cancellations'::regclass and a.attname='observed_at' and pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()')
  or exists(select 1 from pg_policy where polrelid='private_retail_replacement.cancellations'::regclass)
  or(select count(*) from pg_constraint where conrelid='private_retail_replacement.cancellations'::regclass)<>4
  or(select md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) from pg_constraint
   where conrelid='private_retail_replacement.cancellations'::regclass) is distinct from 'CONSTRAINT_MD5'
  or exists(select 1 from pg_constraint where conrelid='private_retail_replacement.cancellations'::regclass and not convalidated)
  or(select count(*) from pg_index where indrelid='private_retail_replacement.cancellations'::regclass)<>1
  or not exists(select 1 from pg_index ix join pg_class idx on idx.oid=ix.indexrelid join pg_am am on am.oid=idx.relam
   join pg_opclass op on op.oid=ix.indclass[0] join pg_namespace ns on ns.oid=op.opcnamespace
   where ix.indrelid='private_retail_replacement.cancellations'::regclass and am.amname='btree' and ns.nspname='pg_catalog'
    and op.opcname='uuid_ops' and ix.indisunique and ix.indisvalid and ix.indisready and ix.indislive and ix.indimmediate
    and ix.indnkeyatts=1 and ix.indnatts=1 and ix.indkey[0]=1 and ix.indpred is null and ix.indexprs is null)
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.cancellations'::regclass and contype='p' and conkey=array[1]::smallint[])
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.cancellations'::regclass and contype='f'
   and conkey=array[1]::smallint[] and confrelid='private_retail_replacement.reservations'::regclass and confdeltype='r')
  or not has_table_privilege('service_role','private_retail_replacement.cancellations','SELECT')
  or not has_table_privilege('service_role','private_retail_replacement.cancellations','INSERT')
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   where c.oid='private_retail_replacement.cancellations'::regclass
    and(x.grantee not in(c.relowner,(select oid from pg_roles where rolname='service_role'))
     or(x.grantee=(select oid from pg_roles where rolname='service_role') and x.privilege_type not in('SELECT','INSERT'))))
  or(select count(*) from pg_trigger where tgrelid='private_retail_replacement.cancellations'::regclass and not tgisinternal)<>1
  or not exists(select 1 from pg_trigger where tgrelid='private_retail_replacement.cancellations'::regclass and tgname='immutable_observation'
   and tgfoid='private_retail_replacement.observation_guard()'::regprocedure and tgtype=31 and tgenabled='O' and not tgisinternal)
  then raise exception 'retail_cancel_observation_schema_drift';end if;
 foreach s slice 1 in array array[
  array['private_retail_replacement.observation_proof(uuid,jsonb,text,jsonb)','PROOF_MD5'],
  array['private_retail_replacement.observation_guard()','GUARD_MD5'],
  array['public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb)','RECORD_MD5']] loop
  select * into p from pg_proc where oid=to_regprocedure(s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] or p.prosecdef or p.proisstrict or p.provolatile<>'v'
   or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   or(select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)<>1
   then raise exception 'retail_cancel_observation_function_drift';end if;
 end loop;
 select * into p from pg_proc where oid='private_retail_replacement.observation_schema_guard()'::regprocedure;
 if md5(regexp_replace(p.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
  is distinct from substring(self_pin from 10) or p.prosecdef or p.provolatile<>'s' or p.proisstrict
  or p.proconfig is distinct from array['search_path=pg_catalog']
  or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',p.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  or(select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)<>1
  then raise exception 'retail_cancel_observation_function_drift';end if;
end $$;

-- NO ROW LOCKS or live funding/current eligibility: this is a delayed FACT,
-- never permission to cancel, bill or grant access from expired evidence.
create function private_retail_replacement.observation_proof(p_agreement uuid,p_request jsonb,p_account text,p_old jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare r private_retail_replacement.reservations;q jsonb;clock timestamptz;n bigint;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' then raise exception 'retail_cancel_observation_server_only';end if;
 perform private_retail_replacement.schema_guard();
 select * into r from private_retail_replacement.reservations where agreement_id=p_agreement;
 if not found or p_request is distinct from r.request then raise exception 'retail_cancel_observation_request_denied';end if;
 q:=r.request;clock:=clock_timestamp();
 if not coalesce(public.retail_existing_closed_object(q,array['version','api_version','agreement_id','client_id','intent_id','source_digest',
  'funding_receipt_digest','provider_account_id','livemode','customer_id','old_subscription_id','new_subscription_id','cancellation'])
  and q->>'version'='retail_existing_replacement_cancel_v1' and q->>'api_version'='2023-10-16'
  and q->>'agreement_id'=p_agreement::text and jsonb_typeof(q->'client_id')='string'
  and(q->'intent_id'='null'::jsonb or jsonb_typeof(q->'intent_id')='string')
  and jsonb_typeof(q->'source_digest')='string' and q->>'source_digest'~'^[a-f0-9]{64}$'
  and jsonb_typeof(q->'funding_receipt_digest')='string' and q->>'funding_receipt_digest'~'^[a-f0-9]{64}$'
  and jsonb_typeof(q->'provider_account_id')='string' and q->>'provider_account_id'~'^acct_[A-Za-z0-9_]+$'
  and p_account=q->>'provider_account_id' and jsonb_typeof(q->'livemode')='boolean'
  and jsonb_typeof(q->'customer_id')='string' and q->>'customer_id'~'^cus_[A-Za-z0-9_]+$'
  and jsonb_typeof(q->'old_subscription_id')='string' and q->>'old_subscription_id'~'^sub_[A-Za-z0-9_]+$'
  and jsonb_typeof(q->'new_subscription_id')='string' and q->>'new_subscription_id'~'^sub_[A-Za-z0-9_]+$'
  and q->>'old_subscription_id'<>q->>'new_subscription_id'
  and q->'cancellation'=jsonb_build_object('method','DELETE','path','/v1/subscriptions/'||(q->>'old_subscription_id'),
   'parameters',jsonb_build_object('invoice_now',false,'prorate',false),'policy','immediate_cancel')
  and isfinite(r.created_at) and r.created_at<=clock,false) then raise exception 'retail_cancel_observation_request_denied';end if;
 if not coalesce(public.retail_existing_closed_object(p_old,array['id','customer','currency','livemode','status','canceled_at'])
  and p_old->'id'=q->'old_subscription_id' and p_old->'customer'=q->'customer_id'
  and p_old->>'currency'='usd' and jsonb_typeof(p_old->'livemode')='boolean' and p_old->'livemode'=q->'livemode'
  and p_old->>'status'='canceled' and jsonb_typeof(p_old->'canceled_at')='number'
  and p_old->>'canceled_at'~'^[1-9][0-9]{0,11}$',false) then raise exception 'retail_cancel_observation_provider_denied';end if;
 n:=(p_old->>'canceled_at')::bigint;clock:=clock_timestamp();
 if n>253402300799 or n>floor(extract(epoch from clock)) or r.created_at>clock then raise exception 'retail_cancel_observation_clock_denied';end if;
 return jsonb_build_object('version','retail_existing_replacement_canceled_observation_v1','api_version','2023-10-16','request',q,
  'journal_created_at',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'provider_account_id',p_account,'old_subscription',p_old);
end $$;

create function private_retail_replacement.observation_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare ctx jsonb;expected jsonb;
begin
 if TG_OP<>'INSERT' then raise exception 'retail_cancel_observation_immutable';end if;
 if current_user<>'service_role' then raise exception 'retail_cancel_observation_writer_denied';end if;
 perform private_retail_replacement.observation_schema_guard();
 ctx:=nullif(current_setting('private_retail_replacement.observation_writer',true),'')::jsonb;
 if ctx is null then raise exception 'retail_cancel_observation_writer_denied';end if;
 expected:=private_retail_replacement.observation_proof(new.agreement_id,ctx->'request',ctx->>'provider_account_id',ctx->'old_subscription');
 if ctx is distinct from expected or new.observation is distinct from expected then raise exception 'retail_cancel_observation_body_denied';end if;
 new.observed_at:=clock_timestamp();
 if not isfinite(new.observed_at) or new.observed_at<(expected->>'journal_created_at')::timestamptz then raise exception 'retail_cancel_observation_clock_denied';end if;
 return new;
end $$;
create trigger immutable_observation before insert or update or delete on private_retail_replacement.cancellations
 for each row execute function private_retail_replacement.observation_guard();

create function public.record_retail_existing_replacement_canceled(p_agreement uuid,p_request jsonb,p_account text,p_old jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare expected jsonb;saved private_retail_replacement.cancellations;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' then raise exception 'retail_cancel_observation_server_only';end if;
 perform set_config('private_retail_replacement.observation_writer','',true);
 perform private_retail_replacement.observation_schema_guard();
 perform pg_catalog.pg_advisory_xact_lock(1632842307,pg_catalog.hashtext(p_agreement::text));
 expected:=private_retail_replacement.observation_proof(p_agreement,p_request,p_account,p_old);
 select * into saved from private_retail_replacement.cancellations where agreement_id=p_agreement;
 if saved.agreement_id is not null then
  if saved.observation is distinct from private_retail_replacement.observation_proof(p_agreement,p_request,p_account,p_old)
   or not isfinite(saved.observed_at) or saved.observed_at<(expected->>'journal_created_at')::timestamptz
   or saved.observed_at>clock_timestamp() then raise exception 'retail_cancel_observation_body_denied';end if;
  perform set_config('private_retail_replacement.observation_writer','',true);
  return jsonb_build_object('status','existing','observation',saved.observation,'observed_at',to_char(saved.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 end if;
 perform set_config('private_retail_replacement.observation_writer',expected::text,true);
 begin
  insert into private_retail_replacement.cancellations(agreement_id,observation) values(p_agreement,expected) returning * into saved;
 exception when unique_violation then
  perform set_config('private_retail_replacement.observation_writer','',true);
  select * into saved from private_retail_replacement.cancellations where agreement_id=p_agreement;
  if saved.agreement_id is null or saved.observation is distinct from private_retail_replacement.observation_proof(p_agreement,p_request,p_account,p_old)
   or not isfinite(saved.observed_at) or saved.observed_at<(expected->>'journal_created_at')::timestamptz
   or saved.observed_at>clock_timestamp() then raise exception 'retail_cancel_observation_body_denied';end if;
  return jsonb_build_object('status','existing','observation',saved.observation,'observed_at',to_char(saved.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 end;
 perform set_config('private_retail_replacement.observation_writer','',true);
 if saved.observation is distinct from private_retail_replacement.observation_proof(p_agreement,p_request,p_account,p_old)
  or saved.observed_at>clock_timestamp() then raise exception 'retail_cancel_observation_body_denied';end if;
 return jsonb_build_object('status','observed','observation',saved.observation,'observed_at',to_char(saved.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;
revoke all on function private_retail_replacement.observation_schema_guard(),private_retail_replacement.observation_proof(uuid,jsonb,text,jsonb),
 private_retail_replacement.observation_guard(),public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function private_retail_replacement.observation_schema_guard(),private_retail_replacement.observation_proof(uuid,jsonb,text,jsonb),
 private_retail_replacement.observation_guard(),public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb) to service_role;
do $pins$
declare p record;body text;digest text;sig text;token text;
begin
 perform set_config('search_path','pg_catalog',true);
 select * into p from pg_proc where oid='private_retail_replacement.observation_schema_guard()'::regprocedure;body:=p.prosrc;
 select md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) into digest from pg_constraint where conrelid='private_retail_replacement.cancellations'::regclass;
 body:=replace(body,'CONSTRAINT_MD5',digest);
 for sig,token in select * from(values
  ('private_retail_replacement.observation_proof(uuid,jsonb,text,jsonb)','PROOF_MD5'),
  ('private_retail_replacement.observation_guard()','GUARD_MD5'),
  ('public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb)','RECORD_MD5'))v(signature,placeholder) loop
  select md5(prosrc) into digest from pg_proc where oid=to_regprocedure(sig);body:=replace(body,token,digest);
 end loop;
 digest:=md5(body);body:=replace(body,$needle$self_pin text:='SELF_MD5:00000000000000000000000000000000'$needle$,
  format('self_pin text:=%L','SELF_MD5:'||digest));
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
end $pins$;
select private_retail_replacement.observation_schema_guard();
commit;
