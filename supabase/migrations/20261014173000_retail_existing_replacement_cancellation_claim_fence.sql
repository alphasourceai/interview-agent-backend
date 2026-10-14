-- LOCAL ONLY. Replace the unmounted observation RPC with a linked-claim
-- fenced version. Provider effects are mounted separately in application code.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 perform private_retail_replacement.observation_schema_guard();
 if to_regprocedure('public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb)') is null
  or to_regprocedure('public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb)') is not null
  or to_regclass('private_retail_replacement.observation_claim_checks') is not null
  or exists(select 1 from pg_proc where pronamespace='private_retail_replacement'::regnamespace
   and proname in('claim_schema_guard','claim_live','claim_commit_guard','claim_row_guard'))
  then raise exception 'retail_cancel_claim_baseline_drift';end if;
end $baseline$;

create table private_retail_replacement.observation_claim_checks(
 agreement_id uuid not null references private_retail_replacement.cancellations(agreement_id) on delete cascade,
 intent_id uuid not null references public.public_purchase_intents(id) on delete restrict,
 primary key(agreement_id,intent_id)
);
alter table private_retail_replacement.observation_claim_checks enable row level security;
revoke all on private_retail_replacement.observation_claim_checks from public,anon,authenticated,service_role;
grant select,insert,delete on private_retail_replacement.observation_claim_checks to service_role;

create function private_retail_replacement.claim_live(p_agreement uuid,p_intent uuid,p_claim text)
returns boolean language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare i public.public_purchase_intents;a public.membership_agreements;r private_retail_replacement.reservations;clock timestamptz;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or p_claim is null or length(p_claim)<32 then raise exception 'retail_cancel_observation_claim_denied';end if;
 select * into i from public.public_purchase_intents where id=p_intent and agreement_id=p_agreement for update;
 if not found then raise exception 'retail_cancel_observation_claim_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement;
 select * into r from private_retail_replacement.reservations where agreement_id=p_agreement;
 clock:=clock_timestamp();
 if a.id is null or a.template_version is distinct from 'membership_agreement_retail_terms_v2'
  or a.status not in('signed','active') or a.is_current is distinct from true or a.voided_at is not null
  or a.superseded_at is not null or a.superseded_by_agreement_id is not null
  or a.checkout_status is distinct from 'paid' or a.checkout_paid_at is null
  or i.protocol is distinct from 'fenced_v2' or i.status is distinct from 'completed'
  or i.agreement_id is distinct from a.id or i.client_id is distinct from a.client_id or i.canceled_at is not null
  or i.activated_at is distinct from a.checkout_paid_at or i.stripe_checkout_session_id is distinct from a.checkout_session_id
  or i.activation_claim_key is distinct from p_claim or i.activation_claimed_at is null
  or not isfinite(i.activation_claimed_at) or i.activation_claimed_at>clock
  or i.activation_claimed_at<clock-interval '5 minutes'
  or r.agreement_id is null or r.request->>'intent_id' is distinct from p_intent::text
  or r.request->>'client_id' is distinct from a.client_id::text
  or r.request->>'old_subscription_id' is distinct from a.replaces_stripe_subscription_id
  or a.replacement_policy is distinct from 'immediate_cancel'
  or encode(sha256(convert_to(a.checkout_attempt_source::text,'UTF8')),'hex') is distinct from r.request->>'source_digest'
  or encode(sha256(convert_to(a.retail_funding_receipt::text,'UTF8')),'hex') is distinct from r.request->>'funding_receipt_digest'
  or not coalesce(public.retail_existing_funding_receipt_valid(a.retail_funding_receipt,a.checkout_attempt_source),false)
  then raise exception 'retail_cancel_observation_claim_denied';end if;
 return true;
end $$;

create function private_retail_replacement.claim_row_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare ctx jsonb;claim text;
begin
 if current_user<>'service_role' then raise exception 'retail_cancel_observation_claim_denied';end if;
 ctx:=nullif(current_setting('private_retail_replacement.observation_claim',true),'')::jsonb;
 if TG_OP='INSERT' then
  claim:=ctx->>'claim';
  if ctx is null or ctx->>'agreement_id' is distinct from new.agreement_id::text
   or ctx->>'intent_id' is distinct from new.intent_id::text
   or ctx->>'request_digest' !~ '^[a-f0-9]{64}$'
   or not private_retail_replacement.claim_live(new.agreement_id,new.intent_id,claim)
   then raise exception 'retail_cancel_observation_claim_denied';end if;
  return new;
 end if;
 if TG_OP='DELETE' and ctx->>'cleanup'='deferred_commit' and ctx->>'agreement_id'=old.agreement_id::text
  and ctx->>'intent_id'=old.intent_id::text then return old;end if;
 raise exception 'retail_cancel_observation_claim_denied';
end $$;
create trigger claim_rows_immutable before insert or update or delete on private_retail_replacement.observation_claim_checks
 for each row execute function private_retail_replacement.claim_row_guard();

create function private_retail_replacement.claim_commit_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare ctx jsonb;r private_retail_replacement.reservations;o private_retail_replacement.cancellations;expected jsonb;
begin
 if current_user<>'service_role' or TG_OP<>'INSERT' then raise exception 'retail_cancel_observation_claim_denied';end if;
 ctx:=nullif(current_setting('private_retail_replacement.observation_claim',true),'')::jsonb;
 select * into r from private_retail_replacement.reservations where agreement_id=new.agreement_id;
 select * into o from private_retail_replacement.cancellations where agreement_id=new.agreement_id;
 if ctx is null or ctx->>'agreement_id' is distinct from new.agreement_id::text
  or ctx->>'intent_id' is distinct from new.intent_id::text or ctx->>'cleanup' is not null
  or ctx->>'request_digest' !~ '^[a-f0-9]{64}$'
  or r.agreement_id is null or o.agreement_id is null or r.request->>'intent_id' is distinct from new.intent_id::text
  or encode(sha256(convert_to(r.request::text,'UTF8')),'hex') is distinct from ctx->>'request_digest'
  or not private_retail_replacement.claim_live(new.agreement_id,new.intent_id,ctx->>'claim')
  then raise exception 'retail_cancel_observation_claim_denied';end if;
 expected:=private_retail_replacement.observation_proof(new.agreement_id,r.request,r.request->>'provider_account_id',o.observation->'old_subscription');
 if o.observation is distinct from expected then raise exception 'retail_cancel_observation_claim_denied';end if;
 perform private_retail_replacement.claim_live(new.agreement_id,new.intent_id,ctx->>'claim');
 perform set_config('private_retail_replacement.observation_claim',jsonb_build_object('agreement_id',new.agreement_id,
  'intent_id',new.intent_id,'claim',ctx->>'claim','request_digest',ctx->>'request_digest','cleanup','deferred_commit')::text,true);
 delete from private_retail_replacement.observation_claim_checks where agreement_id=new.agreement_id and intent_id=new.intent_id;
 if not found then raise exception 'retail_cancel_observation_claim_denied';end if;
 perform set_config('private_retail_replacement.observation_claim','',true);
 return null;
end $$;
create constraint trigger observation_claim_commit_fence after insert on private_retail_replacement.observation_claim_checks
 deferrable initially deferred for each row execute function private_retail_replacement.claim_commit_guard();

create function private_retail_replacement.claim_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p record;s text[];self_pin text:='SELF_MD5:00000000000000000000000000000000';
begin
 perform private_retail_replacement.observation_schema_guard();
 if not exists(select 1 from pg_class where oid='private_retail_replacement.observation_claim_checks'::regclass
   and relkind='r' and relrowsecurity and relowner=(select oid from pg_roles where rolname='postgres'))
  or(select count(*) from pg_attribute where attrelid='private_retail_replacement.observation_claim_checks'::regclass and attnum>0 and not attisdropped)<>2
  or exists(select 1 from pg_attribute where attrelid='private_retail_replacement.observation_claim_checks'::regclass and attnum>0 and not attisdropped
   and(not attnotnull or(attname in('agreement_id','intent_id') and atttypid<>'uuid'::regtype)
    or attname not in('agreement_id','intent_id')))
  or exists(select 1 from pg_policy where polrelid='private_retail_replacement.observation_claim_checks'::regclass)
  or(select count(*) from pg_attrdef where adrelid='private_retail_replacement.observation_claim_checks'::regclass)<>0
  or(select count(*) from pg_constraint where conrelid='private_retail_replacement.observation_claim_checks'::regclass)<>4
  or(select md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) from pg_constraint
   where conrelid='private_retail_replacement.observation_claim_checks'::regclass) is distinct from 'CONSTRAINT_MD5'
  or(select count(*) from pg_index where indrelid='private_retail_replacement.observation_claim_checks'::regclass)<>1
  or not exists(select 1 from pg_index ix join pg_class idx on idx.oid=ix.indexrelid join pg_am am on am.oid=idx.relam
   join pg_opclass op1 on op1.oid=ix.indclass[0] join pg_namespace ns1 on ns1.oid=op1.opcnamespace
   join pg_opclass op2 on op2.oid=ix.indclass[1] join pg_namespace ns2 on ns2.oid=op2.opcnamespace
   where ix.indrelid='private_retail_replacement.observation_claim_checks'::regclass and am.amname='btree'
    and ns1.nspname='pg_catalog' and op1.opcname='uuid_ops' and ns2.nspname='pg_catalog' and op2.opcname='uuid_ops'
    and ix.indisunique and ix.indisvalid and ix.indisready and ix.indislive and ix.indimmediate
    and ix.indnkeyatts=2 and ix.indnatts=2 and ix.indkey[0]=1 and ix.indkey[1]=2 and ix.indpred is null and ix.indexprs is null)
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.observation_claim_checks'::regclass
   and contype='p' and conkey=array[1,2]::smallint[])
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.observation_claim_checks'::regclass
   and contype='f' and conkey=array[1]::smallint[] and confrelid='private_retail_replacement.cancellations'::regclass and confdeltype='c')
  or not exists(select 1 from pg_constraint where conrelid='private_retail_replacement.observation_claim_checks'::regclass
   and contype='f' and conkey=array[2]::smallint[] and confrelid='public.public_purchase_intents'::regclass and confdeltype='r')
  or not has_table_privilege('service_role','private_retail_replacement.observation_claim_checks','SELECT')
  or not has_table_privilege('service_role','private_retail_replacement.observation_claim_checks','INSERT')
  or not has_table_privilege('service_role','private_retail_replacement.observation_claim_checks','DELETE')
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   where c.oid='private_retail_replacement.observation_claim_checks'::regclass
    and(x.grantee not in(c.relowner,(select oid from pg_roles where rolname='service_role'))
     or(x.grantee=(select oid from pg_roles where rolname='service_role') and x.privilege_type not in('SELECT','INSERT','DELETE'))))
  or(select count(*) from pg_trigger where tgrelid='private_retail_replacement.observation_claim_checks'::regclass and not tgisinternal)<>2
  or not exists(select 1 from pg_trigger where tgrelid='private_retail_replacement.observation_claim_checks'::regclass
   and tgname='claim_rows_immutable' and tgfoid='private_retail_replacement.claim_row_guard()'::regprocedure and tgtype=31 and tgenabled='O' and not tgisinternal)
  or not exists(select 1 from pg_trigger where tgrelid='private_retail_replacement.observation_claim_checks'::regclass
   and tgname='observation_claim_commit_fence' and tgfoid='private_retail_replacement.claim_commit_guard()'::regprocedure
    and tgtype=5 and tgenabled='O' and not tgisinternal and tgdeferrable and tginitdeferred and tgconstraint<>0)
  then raise exception 'retail_cancel_claim_schema_drift';end if;
 for p in select * from pg_proc where oid in(
  'private_retail_replacement.claim_live(uuid,uuid,text)'::regprocedure,
  'private_retail_replacement.claim_row_guard()'::regprocedure,
  'private_retail_replacement.claim_commit_guard()'::regprocedure) loop
  if p.proisstrict or p.prosecdef or p.provolatile<>'v' or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
   or p.proowner<>(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_cancel_claim_function_drift';end if;
 end loop;
 foreach s slice 1 in array array[
  array['private_retail_replacement.claim_live(uuid,uuid,text)','CLAIM_LIVE_MD5'],
  array['private_retail_replacement.claim_row_guard()','ROW_GUARD_MD5'],
  array['private_retail_replacement.claim_commit_guard()','COMMIT_GUARD_MD5']] loop
  select * into p from pg_proc where oid=to_regprocedure(s[1]);
  if not found or md5(p.prosrc) is distinct from s[2] then raise exception 'retail_cancel_claim_function_drift';end if;
 end loop;
 select * into p from pg_proc where oid='private_retail_replacement.claim_schema_guard()'::regprocedure;
 if md5(regexp_replace(p.prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
   is distinct from substring(self_pin from 10) or p.prosecdef or p.provolatile<>'s' or p.proisstrict
  or p.proconfig is distinct from array['search_path=pg_catalog']
  or p.proowner<>(select oid from pg_roles where rolname='postgres')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'retail_cancel_claim_function_drift';end if;
end $$;

create function public.record_retail_existing_replacement_canceled(
 p_agreement uuid,p_intent uuid,p_claim text,p_request jsonb,p_account text,p_old jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare i public.public_purchase_intents;a public.membership_agreements;c public.clients;r private_retail_replacement.reservations;
 saved private_retail_replacement.cancellations;expected jsonb;claim_ctx jsonb;had_saved boolean:=false;n integer:=0;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' then raise exception 'retail_cancel_observation_server_only';end if;
 perform set_config('private_retail_replacement.observation_claim','',true);
 perform private_retail_replacement.claim_schema_guard();
 -- Fixed lock order: intent set, agreement, client, billing customer, plan settings, advisory.
 for i in select * from public.public_purchase_intents where agreement_id=p_agreement order by id for update loop n:=n+1;end loop;
 if n<>1 or i.id is distinct from p_intent then raise exception 'retail_cancel_observation_claim_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found then raise exception 'retail_cancel_observation_claim_denied';end if;
 select * into c from public.clients where id=a.client_id for update;
 if not found then raise exception 'retail_cancel_observation_claim_denied';end if;
 perform 1 from public.billing_customers where client_id=c.id and stripe_customer_id=c.stripe_customer_id order by id for share;
 perform 1 from public.client_plan_settings where client_id=c.id for share;
 perform pg_advisory_xact_lock(1632842307,hashtext(p_agreement::text));
 perform private_retail_replacement.claim_live(p_agreement,p_intent,p_claim);
 perform private_retail_replacement.observation_schema_guard();
 select * into r from private_retail_replacement.reservations where agreement_id=p_agreement;
 if r.agreement_id is null or p_request is distinct from r.request then raise exception 'retail_cancel_observation_request_denied';end if;
 expected:=private_retail_replacement.observation_proof(p_agreement,p_request,p_account,p_old);
 select * into saved from private_retail_replacement.cancellations where agreement_id=p_agreement;
 if saved.agreement_id is not null then
  had_saved:=true;
  if saved.observation is distinct from expected or not isfinite(saved.observed_at)
   or saved.observed_at<(expected->>'journal_created_at')::timestamptz or saved.observed_at>clock_timestamp()
   then raise exception 'retail_cancel_observation_body_denied';end if;
 else
  perform set_config('private_retail_replacement.observation_writer',expected::text,true);
  begin insert into private_retail_replacement.cancellations(agreement_id,observation) values(p_agreement,expected) returning * into saved;
  exception when unique_violation then
   had_saved:=true;
   perform set_config('private_retail_replacement.observation_writer','',true);
   select * into saved from private_retail_replacement.cancellations where agreement_id=p_agreement;
   if saved.agreement_id is null or saved.observation is distinct from expected then raise exception 'retail_cancel_observation_body_denied';end if;
  end;
  perform set_config('private_retail_replacement.observation_writer','',true);
 end if;
 if saved.observation is distinct from expected then raise exception 'retail_cancel_observation_body_denied';end if;
 claim_ctx:=jsonb_build_object('agreement_id',p_agreement,'intent_id',p_intent,'claim',p_claim,
  'request_digest',encode(sha256(convert_to(p_request::text,'UTF8')),'hex'));
 perform set_config('private_retail_replacement.observation_claim',claim_ctx::text,true);
 insert into private_retail_replacement.observation_claim_checks(agreement_id,intent_id) values(p_agreement,p_intent);
 set constraints private_retail_replacement.observation_claim_commit_fence deferred;
 return jsonb_build_object('status',case when had_saved then 'existing' else 'observed' end,
  'observation',saved.observation,'observed_at',to_char(saved.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

revoke all on function private_retail_replacement.claim_live(uuid,uuid,text),private_retail_replacement.claim_row_guard(),
 private_retail_replacement.claim_commit_guard(),private_retail_replacement.claim_schema_guard(),
 public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private_retail_replacement.claim_live(uuid,uuid,text),private_retail_replacement.claim_row_guard(),
 private_retail_replacement.claim_commit_guard(),private_retail_replacement.claim_schema_guard(),
 public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb) to service_role;

-- Keep the existing pinned observer catalog aligned with the new one-signature API.
do $patch_guard$
declare p record;body text;definition text;old_self text;old_sig text:='public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb)';
 new_sig text:='public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb)';old_digest text;new_digest text;normalized text;self_digest text;
begin
 select * into p from pg_proc where oid='private_retail_replacement.observation_schema_guard()'::regprocedure;
 body:=replace(p.prosrc,old_sig,new_sig);
 if body=p.prosrc then raise exception 'retail_cancel_claim_guard_patch_failed';end if;
 select md5(prosrc) into old_digest from pg_proc where oid=to_regprocedure(old_sig);
 select md5(prosrc) into new_digest from pg_proc where oid=new_sig::regprocedure;
 if position(old_digest in body)=0 then raise exception 'retail_cancel_claim_guard_hash_patch_failed';end if;
 body:=replace(body,old_digest,new_digest);
 normalized:=regexp_replace(body,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g');
 self_digest:=md5(normalized);old_self:=substring(body from 'self_pin text:=''SELF_MD5:[a-f0-9]{32}''');
 if old_self is null then raise exception 'retail_cancel_claim_guard_self_pin_missing';end if;
 body:=replace(body,old_self,format('self_pin text:=%L','SELF_MD5:'||self_digest));
 definition:=replace(pg_get_functiondef(p.oid),p.prosrc,body);execute definition;
end $patch_guard$;

do $pins$
declare p record;body text;digest text;sig text;token text;normalized text;self_digest text;old_self text;
begin
 perform set_config('search_path','pg_catalog',true);
 select * into p from pg_proc where oid='private_retail_replacement.claim_schema_guard()'::regprocedure;
 body:=p.prosrc;
 for sig,token in select * from(values
  ('private_retail_replacement.claim_live(uuid,uuid,text)','CLAIM_LIVE_MD5'),
  ('private_retail_replacement.claim_row_guard()','ROW_GUARD_MD5'),
  ('private_retail_replacement.claim_commit_guard()','COMMIT_GUARD_MD5'),
  ('public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb)','RECORD_MD5'))v(signature,placeholder) loop
  select md5(prosrc) into digest from pg_proc where oid=to_regprocedure(sig);body:=replace(body,token,digest);
 end loop;
 digest:=md5(string_agg(pg_get_constraintdef(oid,false),E'\n' order by conname)) from pg_constraint
  where conrelid='private_retail_replacement.observation_claim_checks'::regclass;
 body:=replace(body,'CONSTRAINT_MD5',digest);
 normalized:=regexp_replace(body,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g');
 self_digest:=md5(normalized);old_self:=substring(body from 'self_pin text:=''SELF_MD5:[a-f0-9]{32}''');
 if old_self is null then raise exception 'retail_cancel_claim_self_pin_missing';end if;
 body:=replace(body,old_self,format('self_pin text:=%L','SELF_MD5:'||self_digest));
 execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
 drop function public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb);
 if to_regprocedure('public.record_retail_existing_replacement_canceled(uuid,uuid,text,jsonb,text,jsonb)') is null
  or to_regprocedure('public.record_retail_existing_replacement_canceled(uuid,jsonb,text,jsonb)') is not null
  or md5((select prosrc from pg_proc where oid='private_retail_replacement.claim_schema_guard()'::regprocedure)) is null
  then raise exception 'retail_cancel_claim_finalize_drift';end if;
end $pins$;
commit;
