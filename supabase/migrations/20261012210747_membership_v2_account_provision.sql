-- Private, unmounted after-payment account preparation. No signup confirmation,
-- password/reset/session/email/client/member/access/collection/commission grant.
begin;
create table public.membership_v2_account_contexts (
 id uuid primary key default gen_random_uuid(),
 checkout_context_id uuid not null unique references public.membership_v2_checkout_contexts(id) on delete restrict on update restrict,
 project_url text not null check(project_url ~ '^https://[a-z0-9]{20}\.supabase\.co$'),
 environment text not null check(environment in ('dev','qa','production')),
 admin_key_sha256 text not null check(admin_key_sha256 ~ '^[0-9a-f]{64}$'),
 provisioning_enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at))
);
create function public.membership_v2_guard_account_context()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if (to_jsonb(new)-'provisioning_enabled') is distinct from (to_jsonb(old)-'provisioning_enabled') then
  raise exception 'immutable_account_context';end if;return new;
end $$;
create trigger membership_v2_account_context_update before update on public.membership_v2_account_contexts
 for each row execute function public.membership_v2_guard_account_context();
create trigger membership_v2_account_context_delete before delete on public.membership_v2_account_contexts
 for each row execute function public.membership_v2_reject_mutation();
create table public.membership_v2_account_operations (
 operation_id uuid primary key references public.membership_v2_paid_invoice_facts(operation_id) on delete restrict on update restrict,
 purchase_id uuid not null unique references public.membership_v2_pending_purchases(id) on delete restrict on update restrict,
 context_id uuid not null references public.membership_v2_account_contexts(id) on delete restrict on update restrict,
 request_user_id uuid not null unique check(request_user_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 kind text not null check(kind in ('new','existing_signin','existing_verification')),
 email text not null, source_digest text not null,capture_digest text not null,invoice_digest text not null,
 provider_paid_at bigint not null, created_at timestamptz not null check(isfinite(created_at)),
 ownership_verified boolean not null default false check(not ownership_verified),
 access_enabled boolean not null default false check(not access_enabled),
 email_enabled boolean not null default false check(not email_enabled)
);
-- Existing users may be recipients of multiple genuine paid purchases. Only a
-- new request UUID is globally allocated once; do not make Auth email an owner.
alter table public.membership_v2_account_operations drop constraint membership_v2_account_operations_request_user_id_key;
create unique index membership_v2_new_account_request_id on public.membership_v2_account_operations(request_user_id) where kind='new';
create table public.membership_v2_account_dispatches (
 operation_id uuid primary key references public.membership_v2_account_operations(operation_id) on delete restrict on update restrict,
 nonce_hash text not null check(nonce_hash ~ '^[0-9a-f]{64}$'),
 started_at timestamptz not null check(isfinite(started_at))
);
create table public.membership_v2_account_bindings (
 operation_id uuid primary key references public.membership_v2_account_operations(operation_id) on delete restrict on update restrict,
 user_id uuid not null references auth.users(id) on delete restrict on update restrict,
 proof jsonb not null check(public.membership_v2_fact_keys(proof,array['user_id','email','created_at','confirmed_at','role','aud','anonymous','sso'])),
 proof_digest text not null, recorded_at timestamptz not null check(isfinite(recorded_at)),
 ownership_verified boolean not null default false check(not ownership_verified),
 access_enabled boolean not null default false check(not access_enabled),
 email_enabled boolean not null default false check(not email_enabled)
);
create table public.membership_v2_account_holds (
 id uuid primary key default gen_random_uuid(),
 operation_id uuid not null references public.membership_v2_account_operations(operation_id) on delete restrict on update restrict,
 context_id uuid not null references public.membership_v2_account_contexts(id) on delete restrict on update restrict,
 reason text not null check(reason in ('preflight_held','dispatch_ack_unknown','creation_readback_held','binding_readback_held','identity_held')),
 observed_at timestamptz not null check(isfinite(observed_at)),
 reconciliation_writes_enabled boolean not null default false check(not reconciliation_writes_enabled)
);

create function membership_v2_private.account_provision(p_operation uuid,p_context uuid,p_project text,p_environment text,
 p_key_hash text,p_action text,p_nonce text,p_user jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.membership_v2_checkout_operations; cfg public.membership_v2_account_contexts;
 c public.membership_v2_capture_facts; i public.membership_v2_paid_invoice_facts;
 r public.membership_v2_account_operations; d public.membership_v2_account_dispatches; b public.membership_v2_account_bindings;
 u auth.users; ids uuid[]; n timestamptz; x jsonb; e text; uid uuid; kind text; current_user_proof jsonb;
begin
 if current_setting('role',true) is distinct from 'service_role' or p_action is null
  or p_action not in ('reserve','read','dispatch','bind','hold') then raise exception 'membership_account_setup_held';end if;
 select * into o from public.membership_v2_checkout_operations where id=p_operation for update;
 if not found then raise exception 'membership_account_setup_held';end if;
 select * into cfg from public.membership_v2_account_contexts where id=p_context for share;
 if not found or cfg.checkout_context_id<>o.context_id
  or cfg.project_url is distinct from p_project or cfg.environment is distinct from p_environment
  or cfg.admin_key_sha256 is distinct from p_key_hash then raise exception 'membership_account_setup_held';end if;
 if p_action='hold' then
  select * into r from public.membership_v2_account_operations where operation_id=o.id;
  if not found or r.context_id<>cfg.id or r.source_digest<>o.source_digest or p_user is not null
   or p_nonce is null or p_nonce not in ('preflight_held','dispatch_ack_unknown','creation_readback_held','binding_readback_held','identity_held') then
   raise exception 'membership_account_setup_held';end if;
  insert into public.membership_v2_account_holds(operation_id,context_id,reason,observed_at) values(o.id,cfg.id,p_nonce,clock_timestamp());
  return jsonb_build_object('held',true);
 end if;
 if not cfg.provisioning_enabled then raise exception 'membership_account_setup_held';end if;
 x:=public.membership_v2_financial_context(o.id);
 if x->'context'->>'environment' is distinct from cfg.environment then raise exception 'membership_account_setup_held';end if;
 e:=public.membership_v2_buyer_email(x->'purchase'->'source_snapshot'->'source'->'buyer'->>'buyer_email');
 -- Serialize our same-email reservations; no claim that this locks external
 -- Auth API requests. Explicit request UUID prevents adopting an email race.
 perform pg_advisory_xact_lock(hashtextextended(cfg.project_url||chr(10)||e,0));
 select array_agg(t.id) into ids from (select id from auth.users where
  translate(btrim(email,chr(32)||chr(9)||chr(10)||chr(13)||chr(12)||chr(11)),
   'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=e order by id limit 2) t;
 if cardinality(ids)>1 then raise exception 'membership_account_setup_held';end if;
 select * into r from public.membership_v2_account_operations where operation_id=o.id;
 if cardinality(ids)=1 then
  select * into u from auth.users where id=ids[1] for share;
  if not found then raise exception 'membership_account_setup_held';end if;
 end if;
 n:=clock_timestamp();
 select * into c from public.membership_v2_capture_facts where operation_id=o.id;
 if not found then raise exception 'membership_account_setup_held';end if;
 select * into i from public.membership_v2_paid_invoice_facts where operation_id=o.id;
 if not found or c.purchase_id<>o.purchase_id or c.source_digest<>o.source_digest or i.source_digest<>o.source_digest
  or c.proof_digest<>encode(pg_catalog.sha256(convert_to(c.proof::text,'UTF8')),'hex')
  or i.proof_digest<>encode(pg_catalog.sha256(convert_to(i.proof::text,'UTF8')),'hex')
  or not public.membership_v2_capture_proof_matches(o.id,c.proof)
  or not public.membership_v2_invoice_proof_matches(o.id,i.proof)
  or to_timestamp(i.provider_paid_at)>n then raise exception 'membership_account_setup_held';end if;
 if u.id is not null then
  if public.membership_v2_buyer_email(u.email) is distinct from e or u.deleted_at is not null
   or u.is_anonymous is distinct from false or u.is_sso_user is distinct from false
   or u.role is distinct from 'authenticated' or u.aud is distinct from 'authenticated'
   or (u.banned_until is not null and u.banned_until>n) or u.created_at is null or not isfinite(u.created_at) or u.created_at>n
   or (u.email_confirmed_at is not null and (not isfinite(u.email_confirmed_at) or u.email_confirmed_at>n)) then
   raise exception 'membership_account_setup_held';end if;
  current_user_proof:=jsonb_build_object('user_id',u.id,'email',e,
   'created_at',to_char(u.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'confirmed_at',case when u.email_confirmed_at is null then null else to_char(u.email_confirmed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
   'role',u.role,'aud',u.aud,'anonymous',u.is_anonymous,'sso',u.is_sso_user);
 end if;
 if r.operation_id is null then
  if p_action<>'reserve' then raise exception 'membership_account_setup_held';end if;
  uid:=coalesce(u.id,gen_random_uuid());kind:=case when u.id is null then 'new'
    when u.email_confirmed_at is null then 'existing_verification' else 'existing_signin' end;
  if kind='new' and exists(select 1 from auth.users where id=uid) then raise exception 'membership_account_setup_held';end if;
  insert into public.membership_v2_account_operations(operation_id,purchase_id,context_id,request_user_id,kind,email,
   source_digest,capture_digest,invoice_digest,provider_paid_at,created_at)
   values(o.id,o.purchase_id,cfg.id,uid,kind,e,o.source_digest,c.proof_digest,i.proof_digest,i.provider_paid_at,n) returning * into r;
 end if;
 if r.purchase_id<>o.purchase_id or r.context_id<>cfg.id or r.email<>e or r.source_digest<>o.source_digest
  or r.capture_digest<>c.proof_digest or r.invoice_digest<>i.proof_digest or r.provider_paid_at<>i.provider_paid_at
  or (u.id is not null and u.id<>r.request_user_id) or (r.kind<>'new' and u.id is null) then raise exception 'membership_account_setup_held';end if;
 select * into d from public.membership_v2_account_dispatches where operation_id=o.id;
 select * into b from public.membership_v2_account_bindings where operation_id=o.id;
 if r.kind='new' and u.id is not null and d.operation_id is null then raise exception 'membership_account_setup_held';end if;
 if p_action='dispatch' then
  if r.kind<>'new' or d.operation_id is not null then return jsonb_build_object('won',false);end if;
  if u.id is not null or exists(select 1 from auth.users where id=r.request_user_id)
   or p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'membership_account_setup_held';end if;
  insert into public.membership_v2_account_dispatches values(o.id,encode(pg_catalog.sha256(convert_to(p_nonce,'UTF8')),'hex'),n) returning * into d;
  return jsonb_build_object('won',true,'operation_id',o.id,'nonce_hash',d.nonce_hash,'started_at',d.started_at);
 end if;
 if p_action='bind' then
  if u.id is null or not public.membership_v2_fact_keys(p_user,array['user_id','email','created_at','confirmed_at','role','aud','anonymous','sso'])
   or octet_length(p_user::text)>1024 or p_user is distinct from current_user_proof
   or (r.kind='new' and b.operation_id is null and u.email_confirmed_at is not null) then raise exception 'membership_account_setup_held';end if;
  if b.operation_id is null then
   insert into public.membership_v2_account_bindings(operation_id,user_id,proof,proof_digest,recorded_at)
    values(o.id,u.id,p_user,encode(pg_catalog.sha256(convert_to(p_user::text,'UTF8')),'hex'),n) returning * into b;
  end if;
 end if;
 if b.operation_id is not null and (u.id is null or b.user_id<>r.request_user_id
  or b.proof_digest<>encode(pg_catalog.sha256(convert_to(b.proof::text,'UTF8')),'hex')
  or (b.proof-'confirmed_at') is distinct from (current_user_proof-'confirmed_at')) then raise exception 'membership_account_setup_held';end if;
 return jsonb_build_object('operation',to_jsonb(r),
  'dispatch',case when d.operation_id is null then null else to_jsonb(d) end,
  'binding',case when b.operation_id is null then null else to_jsonb(b) end,'current_user',current_user_proof,
  'project_url',cfg.project_url,'environment',cfg.environment,'admin_key_sha256',cfg.admin_key_sha256);
exception when others then raise exception 'membership_account_setup_held' using errcode='P0001';
end $$;
create function public.membership_v2_account_provision(p_operation uuid,p_context uuid,p_project text,p_environment text,
 p_key_hash text,p_action text,p_nonce text,p_user jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select membership_v2_private.account_provision(p_operation,p_context,p_project,p_environment,p_key_hash,p_action,p_nonce,p_user);
$$;
do $$declare t text;begin
 foreach t in array array['membership_v2_account_contexts','membership_v2_account_operations','membership_v2_account_dispatches','membership_v2_account_bindings','membership_v2_account_holds'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
  if t<>'membership_v2_account_contexts' then
   execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
  end if;
 end loop;
end $$;
revoke all on function membership_v2_private.account_provision(uuid,uuid,text,text,text,text,text,jsonb),
 public.membership_v2_account_provision(uuid,uuid,text,text,text,text,text,jsonb),public.membership_v2_guard_account_context()
 from public,anon,authenticated,service_role;
grant execute on function membership_v2_private.account_provision(uuid,uuid,text,text,text,text,text,jsonb),
 public.membership_v2_account_provision(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
commit;
