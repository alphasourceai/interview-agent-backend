-- LOCAL WIP, UNMOUNTED, EXCLUDED from the reviewed 34-migration package.
-- R5 approved preparation/reservation design only. Complete native RPCs and
-- concurrency tests/source review before including this file in any manifest.
-- Same existing JS allocator and global interview ledger, not a second claim
-- store. Trusted server content is not SQL reexecution of the allocator.
-- Role+transaction-local marks reject unmarked Data API DML, NOT a malicious
-- privileged SQL operator who can set the mark. Structural checks do not close
-- that content-attestation gap. No provider/access/payroll effects here.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if to_regclass('public.enterprise_existing_usage_batches') is not null
  or exists(select 1 from pg_attribute where attrelid='public.usage_billing_ledger'::regclass
   and attname='enterprise_usage_batch_id' and not attisdropped)
  or to_regprocedure('public.read_enterprise_existing_billing(uuid)') is null
  then raise exception 'enterprise_usage_preparation_prerequisite_drift';end if;
 if not exists(select 1 from pg_constraint where conrelid='public.usage_billing_ledger'::regclass
  and contype='u' and convalidated and conkey=array[(select attnum from pg_attribute
   where attrelid='public.usage_billing_ledger'::regclass and attname='interview_id' and not attisdropped)])
  then raise exception 'enterprise_usage_global_interview_key_drift';end if;
end $baseline$;

create table public.enterprise_existing_usage_batches (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references public.clients(id) on delete restrict,
 agreement_id uuid not null references public.membership_agreements(id) on delete restrict,
 service_month date not null check(extract(day from service_month)=1),
 account_id text not null check(account_id ~ '^acct_[A-Za-z0-9_]+$'),
 livemode boolean not null,
 customer_id text not null check(customer_id ~ '^cus_[A-Za-z0-9_]+$'),
 subscription_id text not null check(subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
 unit_price_cents integer not null check(unit_price_cents>0),
 source_identity jsonb not null check(jsonb_typeof(source_identity)='object'),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=16777216),
 snapshot_digest text not null check(snapshot_digest ~ '^[a-f0-9]{64}$'),
 generation integer not null check(generation>0),
 prepared_at timestamptz not null check(isfinite(prepared_at)),
 expires_at timestamptz not null check(expires_at=prepared_at+interval '30 seconds'),
 phase text not null check(phase in('prepared','reserved','no_usage','held')),
 groups jsonb,
 prefix jsonb,
 reserved_at timestamptz,
 unique(owner_id,service_month),unique(agreement_id,service_month),
 check((phase in('prepared','held') and groups is null and prefix is null and reserved_at is null)
  or(phase in('reserved','no_usage') and jsonb_typeof(groups)='array' and jsonb_typeof(prefix)='array'
   and reserved_at is not null and isfinite(reserved_at)
   and((phase='no_usage' and jsonb_array_length(groups)=0) or(phase='reserved' and jsonb_array_length(groups)>0))))
);
alter table public.enterprise_existing_usage_batches enable row level security;
revoke all on public.enterprise_existing_usage_batches from public,anon,authenticated,service_role;
-- New relation only: UPDATE permits the approved SRE lock and native CAS.
grant select,insert,update on public.enterprise_existing_usage_batches to service_role;
alter table public.usage_billing_ledger add column enterprise_usage_batch_id uuid
 references public.enterprise_existing_usage_batches(id) on delete restrict;
create index usage_billing_ledger_enterprise_batch_idx on public.usage_billing_ledger(enterprise_usage_batch_id)
 where enterprise_usage_batch_id is not null;

create function public.enterprise_existing_usage_batch_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare clock timestamptz;receipt jsonb;
begin
 if TG_OP='DELETE' then raise exception 'enterprise_usage_batch_immutable';end if;
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or current_setting('private_sales.enterprise_usage_writer',true) is distinct from new.id::text
  then raise exception 'enterprise_usage_batch_native_writer_required';end if;
 -- Same seal barrier order: client before this client's agreement. Table SRE
 -- locks alone do NOT conflict with the seal's SELECT FOR UPDATE/RowShare.
 perform 1 from public.clients where id=new.owner_id for update;
 perform 1 from public.membership_agreements where id=new.agreement_id for update;
 if not exists(select 1 from public.membership_agreements where id=new.agreement_id and client_id=new.owner_id)
  then raise exception 'enterprise_usage_batch_owner_denied';end if;
 receipt:=public.read_enterprise_existing_billing(new.agreement_id);
 if receipt is null or receipt->'funding_receipt'->'proof'->>'provider_account_id' is distinct from new.account_id
  or receipt->'funding_receipt'->'proof'->'livemode' is distinct from to_jsonb(new.livemode)
  or receipt->'client_initial'->>'stripe_customer_id' is distinct from new.customer_id
  or receipt->'client_initial'->>'stripe_subscription_id' is distinct from new.subscription_id
  or(receipt->'plan_initial'->>'usage_interview_fee_cents')::integer is distinct from new.unit_price_cents
  then raise exception 'enterprise_usage_batch_source_denied';end if;
 clock:=clock_timestamp();
 if new.prepared_at>clock or new.expires_at is distinct from new.prepared_at+interval '30 seconds'
  or new.snapshot_digest is distinct from encode(sha256(convert_to(new.snapshot::text,'UTF8')),'hex')
  or new.snapshot->>'owner_id' is distinct from new.owner_id::text
  or new.snapshot->>'agreement_id' is distinct from new.agreement_id::text
  then raise exception 'enterprise_usage_batch_snapshot_denied';end if;
 if TG_OP='INSERT' then
  if new.phase<>'prepared' or new.generation<>1 then raise exception 'enterprise_usage_prepare_required';end if;
 else
  if old.phase not in('prepared','held') or new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
   or new.agreement_id is distinct from old.agreement_id or new.service_month is distinct from old.service_month
   or new.account_id is distinct from old.account_id or new.livemode is distinct from old.livemode
   or new.customer_id is distinct from old.customer_id or new.subscription_id is distinct from old.subscription_id
   or new.unit_price_cents is distinct from old.unit_price_cents or new.source_identity is distinct from old.source_identity
   then raise exception 'enterprise_usage_batch_identity_immutable';end if;
  if new.phase='prepared' then
   if old.phase<>'prepared' or new.generation<>old.generation+1
    then raise exception 'enterprise_usage_prepare_cas_denied';end if;
  elsif new.phase in('reserved','no_usage') then
   if old.phase<>'prepared' or new.generation<>old.generation or old.expires_at<clock
    or new.snapshot is distinct from old.snapshot or new.snapshot_digest is distinct from old.snapshot_digest
    or new.prepared_at is distinct from old.prepared_at or new.expires_at is distinct from old.expires_at
    or new.reserved_at is null or new.reserved_at>clock then raise exception 'enterprise_usage_reserve_cas_denied';end if;
  elsif new.phase='held' then
   if new.generation<>old.generation or new.snapshot is distinct from old.snapshot
    then raise exception 'enterprise_usage_hold_cas_denied';end if;
  end if;
 end if;
 return new;
end $$;
create trigger enterprise_existing_usage_batch_guard before insert or update or delete
 on public.enterprise_existing_usage_batches for each row execute function public.enterprise_existing_usage_batch_guard();

create function public.enterprise_existing_usage_ledger_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare b public.enterprise_existing_usage_batches;line jsonb;
begin
 if TG_OP='TRUNCATE' then
  if exists(select 1 from public.usage_billing_ledger where enterprise_usage_batch_id is not null)
   then raise exception 'enterprise_usage_ledger_immutable';end if;return null;
 end if;
 if TG_OP='DELETE' then
  if old.enterprise_usage_batch_id is not null then raise exception 'enterprise_usage_ledger_immutable';end if;return old;
 end if;
 if TG_OP='UPDATE' and old.enterprise_usage_batch_id is not null then raise exception 'enterprise_usage_ledger_immutable';end if;
 if new.enterprise_usage_batch_id is null then return new;end if;
 if TG_OP<>'INSERT' or current_user<>'service_role'
  or current_setting('private_sales.enterprise_usage_writer',true) is distinct from new.enterprise_usage_batch_id::text
  then raise exception 'enterprise_usage_ledger_native_writer_required';end if;
 select * into strict b from public.enterprise_existing_usage_batches where id=new.enterprise_usage_batch_id;
 if b.phase<>'reserved' or new.client_id is distinct from b.owner_id or new.unit_price_cents is distinct from b.unit_price_cents
  or new.stripe_invoice_id is not null or new.stripe_invoice_item_id is not null or new.billed_at is not null
  or new.period_start is distinct from(b.service_month::timestamp at time zone 'UTC')
  or new.period_end is distinct from((b.service_month::timestamp+interval '1 month') at time zone 'UTC')
  then raise exception 'enterprise_usage_ledger_binding_denied';end if;
 select g into strict line from jsonb_array_elements(b.groups)g
  where g->>'role_id'=new.role_id::text and(g->'interview_ids') ? new.interview_id::text;
 return new;
end $$;
create trigger enterprise_existing_usage_ledger_guard before insert or update or delete on public.usage_billing_ledger
 for each row execute function public.enterprise_existing_usage_ledger_guard();
create trigger enterprise_existing_usage_ledger_truncate_guard before truncate on public.usage_billing_ledger
 for each statement execute function public.enterprise_existing_usage_ledger_guard();
revoke all on function public.enterprise_existing_usage_batch_guard(),public.enterprise_existing_usage_ledger_guard()
 from public,anon,authenticated;
grant execute on function public.enterprise_existing_usage_batch_guard(),public.enterprise_existing_usage_ledger_guard() to service_role;

-- Internal census shared by the two pending RPCs, not another allocator or
-- public workflow. Full bidirectional closure includes unused interviews and
-- foreign/dangling bindings so the trusted kernel can hold rather than silently
-- drop them. The canonical JSON is produced by PostgreSQL, not JavaScript.
create function public.enterprise_existing_usage_census(p_owner uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare ids jsonb;node_count bigint;result jsonb;r record;started timestamptz;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or current_setting('private_sales.enterprise_usage_census_reader',true) is distinct from p_owner::text
  or p_owner is null then raise exception 'enterprise_usage_census_native_reader_required';end if;
 started:=clock_timestamp();
 lock table public.clients in share row exclusive mode;
 lock table public.membership_agreements in share row exclusive mode;
 lock table public.client_plan_settings in share row exclusive mode;
 lock table public.roles in share row exclusive mode;
 lock table public.interviews in share row exclusive mode;
 lock table public.role_interview_purchases in share row exclusive mode;
 lock table public.interview_credits in share row exclusive mode;
 lock table public.client_interview_pools in share row exclusive mode;
 lock table public.usage_billing_ledger in share row exclusive mode;
 lock table public.public_purchase_intents in share row exclusive mode;
 lock table public.billing_customers in share row exclusive mode;
 lock table public.enterprise_existing_usage_batches in share row exclusive mode;
 if not exists(select 1 from public.clients where id=p_owner and parent_client_id is null)
  then raise exception 'enterprise_usage_owner_denied';end if;
 if exists(with recursive family(id,path,depth,cycle) as(
  select c.id,array[c.id],0,false from public.clients c where c.id=p_owner
  union all select c.id,f.path||c.id,f.depth+1,c.id=any(f.path)
   from family f join public.clients c on c.parent_client_id=f.id where f.depth<64 and not f.cycle)
  select 1 from family f where f.cycle or(f.depth=64 and exists(select 1 from public.clients c where c.parent_client_id=f.id)))
  then raise exception 'enterprise_usage_family_depth_or_cycle';end if;
 with recursive raw_edges(lrel,lid,rrel,rid) as(
  select 'clients',id,'clients',parent_client_id from public.clients
  union all select 'agreements',id,'clients',client_id from public.membership_agreements
  union all select 'agreements',id,'pools',enterprise_checkout_pool_id from public.membership_agreements
  union all select 'settings',client_id,'clients',client_id from public.client_plan_settings
  union all select 'roles',id,'clients',client_id from public.roles
  union all select 'interviews',id,'clients',client_id from public.interviews
  union all select 'interviews',id,'roles',role_id from public.interviews
  union all select 'purchases',id,'clients',client_id from public.role_interview_purchases
  union all select 'purchases',id,'roles',role_id from public.role_interview_purchases
  union all select 'credits',id,'clients',client_id from public.interview_credits
  union all select 'credits',id,'roles',source_role_id from public.interview_credits
  union all select 'pools',id,'clients',client_id from public.client_interview_pools
  union all select 'pools',id,'agreements',agreement_id from public.client_interview_pools
  union all select 'ledger',id,'clients',client_id from public.usage_billing_ledger
  union all select 'ledger',id,'roles',role_id from public.usage_billing_ledger
  union all select 'ledger',id,'interviews',interview_id from public.usage_billing_ledger
  union all select 'intents',id,'clients',client_id from public.public_purchase_intents
  union all select 'intents',id,'agreements',agreement_id from public.public_purchase_intents
  union all select 'customers',id,'clients',client_id from public.billing_customers
  union all select 'seals',agreement_id,'agreements',agreement_id from public.enterprise_v2_execution_seals
 ),edges(lrel,lid,rrel,rid) as(
  select * from raw_edges where lid is not null and rid is not null
  union all select rrel,rid,lrel,lid from raw_edges where lid is not null and rid is not null
 ),walk(rel,id) as(
  select 'clients'::text,p_owner
  union select e.rrel,e.rid from walk w join edges e on e.lrel=w.rel and e.lid=w.id
 ),grouped as(select rel,jsonb_agg(id order by id) as keys,count(*) as n from walk group by rel)
 select jsonb_object_agg(rel,keys),sum(n) into ids,node_count from grouped;
 if node_count>100000 or clock_timestamp()-started>interval '2 seconds'
  then raise exception 'enterprise_usage_census_capacity_held';end if;
 -- Same-row barrier against seal INSERT. Its table ROW SHARE is compatible
 -- with our table SRE; client-before-agreement row locks are essential.
 for r in select c.id from public.clients c where coalesce(ids->'clients','[]'::jsonb) ? c.id::text order by c.id loop
  perform 1 from public.clients where id=r.id for update;
  perform 1 from public.membership_agreements a where a.client_id=r.id
   and coalesce(ids->'agreements','[]'::jsonb) ? a.id::text order by a.id for update;
 end loop;
 -- No LIMIT: a capacity failure aborts, never certifies a partial prefix.
 select jsonb_build_object(
  'clients',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.clients x where coalesce(ids->'clients','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'agreements',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.membership_agreements x where coalesce(ids->'agreements','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'settings',coalesce((select jsonb_agg(to_jsonb(x) order by x.client_id) from public.client_plan_settings x where coalesce(ids->'settings','[]'::jsonb) ? x.client_id::text),'[]'::jsonb),
  'roles',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.roles x where coalesce(ids->'roles','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'interviews',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.interviews x where coalesce(ids->'interviews','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'purchases',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.role_interview_purchases x where coalesce(ids->'purchases','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'credits',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.interview_credits x where coalesce(ids->'credits','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'pools',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.client_interview_pools x where coalesce(ids->'pools','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'ledger',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.usage_billing_ledger x where coalesce(ids->'ledger','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'intents',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.public_purchase_intents x where coalesce(ids->'intents','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.billing_customers x where coalesce(ids->'customers','[]'::jsonb) ? x.id::text),'[]'::jsonb),
  'seals',coalesce((select jsonb_agg(to_jsonb(x) order by x.agreement_id) from public.enterprise_v2_execution_seals x where coalesce(ids->'seals','[]'::jsonb) ? x.agreement_id::text),'[]'::jsonb)
 ) into result;
 if octet_length(result::text)>16777216 or clock_timestamp()-started>interval '2 seconds'
  then raise exception 'enterprise_usage_census_capacity_held';end if;
 return result;
end $$;
revoke all on function public.enterprise_existing_usage_census(uuid) from public,anon,authenticated;
grant execute on function public.enterprise_existing_usage_census(uuid) to service_role;

create function public.prepare_enterprise_existing_usage(p_owner uuid)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare census jsonb;receipt jsonb;agm uuid;clock_ timestamptz;month_ date;start_ timestamptz;end_ timestamptz;
 b public.enterprise_existing_usage_batches;identity_ jsonb;document_ jsonb;digest_ text;history_ jsonb;
 audit_ jsonb;audit_id text;prior_audit jsonb;steps integer:=0;rate_ integer;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed' or p_owner is null
  then raise exception 'enterprise_usage_prepare_server_only';end if;
 perform set_config('private_sales.enterprise_usage_census_reader',p_owner::text,true);
 census:=public.enterprise_existing_usage_census(p_owner);
 perform set_config('private_sales.enterprise_usage_census_reader','',true);
 -- Native chooser uses the complete locked census, never a caller's source,
 -- rate, account, service month, observed clock or deadline.
 if(select count(*) from jsonb_array_elements(census->'agreements')a where a->>'client_id'=p_owner::text
  and a->>'is_current'='true')<>1 or
  (select count(*) from jsonb_array_elements(census->'agreements')a where
   a->>'enterprise_checkout_source' is not null or a->>'enterprise_checkout_prices' is not null
   or a->>'enterprise_funding_receipt' is not null or a->>'enterprise_billing_receipt' is not null)<>1
  then raise exception 'enterprise_usage_accepted_source_ambiguous';end if;
 select(a->>'id')::uuid into strict agm from jsonb_array_elements(census->'agreements')a
  where a->>'client_id'=p_owner::text and a->>'is_current'='true' and a->>'status'='signed'
   and a->>'checkout_status'='paid' and a->>'enterprise_billing_receipt' is not null
   and a->>'superseded_by_agreement_id' is null and a->>'voided_at' is null;
 receipt:=public.read_enterprise_existing_billing(agm);
 if receipt is null or receipt->'plan_initial'->>'billing_model'<>'usage'
  or receipt->'funding_receipt'->'proof'->>'pool_id' is null
  then raise exception 'enterprise_usage_receipt_required';end if;
 rate_:=(receipt->'plan_initial'->>'usage_interview_fee_cents')::integer;
 if rate_ is null or rate_<=0 then raise exception 'enterprise_usage_accepted_rate_required';end if;
 start_:=(receipt->'client_initial'->>'contract_start_at')::timestamptz;
 end_:=(receipt->'client_initial'->>'contract_end_at')::timestamptz;
 if start_ is null or end_ is null or not isfinite(start_) or not isfinite(end_) or end_<=start_
  then raise exception 'enterprise_usage_service_window_required';end if;
 month_:=date_trunc('month',start_ at time zone 'UTC')::date;
 clock_:=clock_timestamp();
 while month_::timestamp at time zone 'UTC'<end_
  and(month_::timestamp+interval '1 month') at time zone 'UTC'<=clock_ loop
  if not exists(select 1 from public.enterprise_existing_usage_batches where owner_id=p_owner and service_month=month_
   and phase in('reserved','no_usage')) then exit;end if;
  steps:=steps+1;if steps>1000 then raise exception 'enterprise_usage_month_capacity_held';end if;
  month_:=(month_+interval '1 month')::date;
 end loop;
 if month_::timestamp at time zone 'UTC'>=end_
  or(month_::timestamp+interval '1 month') at time zone 'UTC'>clock_
  then return jsonb_build_object('phase','not_due','provider_effect_authorized',false);end if;
 if exists(select 1 from public.enterprise_existing_usage_batches where owner_id=p_owner
  and service_month<month_ and phase not in('reserved','no_usage'))
  then return jsonb_build_object('phase','held','provider_effect_authorized',false);end if;
 select * into b from public.enterprise_existing_usage_batches where owner_id=p_owner and service_month=month_ for update;
 identity_:=jsonb_build_object('agreement_id',agm,'owner_id',p_owner,'service_month',month_,
  'receipt',receipt);
 if b.id is not null and(b.phase<>'prepared' or b.agreement_id<>agm or b.source_identity is distinct from identity_)
  then return jsonb_build_object('phase','held','provider_effect_authorized',false);end if;
 -- Include immutable prior identity/groups/prefix/digest, not its recursively
 -- nested old census document. This still attests all required prior inputs.
 select coalesce(jsonb_agg(to_jsonb(x)-'snapshot' order by x.service_month,x.id),'[]'::jsonb) into history_
  from public.enterprise_existing_usage_batches x where x.owner_id=p_owner and x.phase in('reserved','no_usage');
 clock_:=clock_timestamp();
 document_:=census||jsonb_build_object('version','enterprise_existing_usage_snapshot_v1','owner_id',p_owner,
  'agreement_id',agm,'receipt',receipt,'history',history_,
  'observed_at',to_char(clock_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'month_start',to_char(month_::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'month_end',to_char(month_::timestamp+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 if b.id is not null and b.expires_at>=clock_ and b.snapshot-'observed_at'=document_-'observed_at' then
  return jsonb_build_object('phase','prepared','batch_id',b.id,'generation',b.generation,
   'snapshot_digest',b.snapshot_digest,'snapshot',b.snapshot);
 end if;
 digest_:=encode(sha256(convert_to(document_::text,'UTF8')),'hex');
 if b.id is null then b.id:=gen_random_uuid();b.generation:=0;end if;
 perform set_config('private_sales.enterprise_usage_writer',b.id::text,true);
 if b.generation=0 then
  insert into public.enterprise_existing_usage_batches(id,owner_id,agreement_id,service_month,account_id,livemode,
   customer_id,subscription_id,unit_price_cents,source_identity,snapshot,snapshot_digest,generation,prepared_at,expires_at,phase)
  values(b.id,p_owner,agm,month_,receipt->'funding_receipt'->'proof'->>'provider_account_id',
   (receipt->'funding_receipt'->'proof'->>'livemode')::boolean,receipt->'client_initial'->>'stripe_customer_id',
   receipt->'client_initial'->>'stripe_subscription_id',rate_,identity_,document_,digest_,1,clock_,clock_+interval '30 seconds','prepared')
  returning * into b;
 else
  update public.enterprise_existing_usage_batches set generation=b.generation+1,snapshot=document_,snapshot_digest=digest_,
   prepared_at=clock_,expires_at=clock_+interval '30 seconds' where id=b.id and generation=b.generation and phase='prepared' returning * into strict b;
 end if;
 perform set_config('private_sales.enterprise_usage_writer','',true);
 audit_id:='enterprise-usage-prepare:'||b.id::text||':'||b.generation::text;
 audit_:=jsonb_build_object('version','enterprise_usage_preparation_audit_v1','batch_id',b.id,
  'generation',b.generation,'owner_id',b.owner_id,'agreement_id',b.agreement_id,'service_month',b.service_month,
  'snapshot_digest',b.snapshot_digest,'prepared_at',b.prepared_at,'expires_at',b.expires_at);
 select payload into prior_audit from public.billing_events where stripe_event_id=audit_id for update;
 if found then
  if prior_audit is distinct from audit_ then raise exception 'enterprise_usage_prepare_audit_conflict';end if;
 else
  insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
   values(audit_id,'enterprise.usage.prepared',true,p_owner,audit_);
 end if;
 return jsonb_build_object('phase','prepared','batch_id',b.id,'generation',b.generation,
  'snapshot_digest',b.snapshot_digest,'snapshot',b.snapshot);
end $$;
revoke all on function public.prepare_enterprise_existing_usage(uuid) from public,anon,authenticated;
grant execute on function public.prepare_enterprise_existing_usage(uuid) to service_role;

create function public.reserve_enterprise_existing_usage(p_batch uuid,p_generation integer,p_digest text,p_groups jsonb,p_prefix jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare owner_ uuid;b public.enterprise_existing_usage_batches;census jsonb;receipt jsonb;document_ jsonb;history_ jsonb;
 identity_ jsonb;month_ date;clock_ timestamptz;start_ timestamptz;end_ timestamptz;steps integer:=0;
 g jsonb;e jsonb;iv jsonb;old_ jsonb;previous_ timestamptz;previous_id text;stamp_ timestamptz;
 total_ bigint:=0;seen_ uuid[]:='{}';role_seen_ uuid[]:='{}';prefix_seen_ uuid[]:='{}';iv_id uuid;role_ uuid;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or p_batch is null or p_generation is null or p_generation<1 or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_groups) is distinct from 'array' or jsonb_typeof(p_prefix) is distinct from 'array'
  or jsonb_array_length(p_prefix)>100000 or octet_length(p_groups::text)+octet_length(p_prefix::text)>16777216
  then raise exception 'enterprise_usage_reserve_input_denied';end if;
 select owner_id into owner_ from public.enterprise_existing_usage_batches where id=p_batch;
 if owner_ is null then raise exception 'enterprise_usage_reserve_missing';end if;
 perform set_config('private_sales.enterprise_usage_census_reader',owner_::text,true);
 census:=public.enterprise_existing_usage_census(owner_);
 perform set_config('private_sales.enterprise_usage_census_reader','',true);
 -- Census locks every relevant client/agreement first. Operation row is last.
 select * into strict b from public.enterprise_existing_usage_batches where id=p_batch for update;
 if b.generation<>p_generation or b.snapshot_digest<>p_digest
  then raise exception 'enterprise_usage_reserve_identity_denied';end if;
 receipt:=public.read_enterprise_existing_billing(b.agreement_id);
 identity_:=jsonb_build_object('agreement_id',b.agreement_id,'owner_id',b.owner_id,'service_month',b.service_month,'receipt',receipt);
 if identity_ is distinct from b.source_identity then raise exception 'enterprise_usage_reserve_source_changed';end if;
 if b.phase in('reserved','no_usage') then
  -- A unique error escapes/rolls back. Exact winner is read in a NEW caller
  -- transaction only, never by swallowing unique_violation in this function.
  if b.groups is distinct from p_groups or b.prefix is distinct from p_prefix
   then raise exception 'enterprise_usage_reserve_winner_conflict';end if;
  select coalesce(sum((x->>'amount_cents')::bigint),0) into total_ from jsonb_array_elements(b.groups)x;
  return jsonb_build_object('phase',b.phase,'batch_id',b.id,'generation',b.generation,'total_cents',total_,
   'provider_effect_authorized',false,'paid_access_authorized',false);
 end if;
 if b.phase<>'prepared' then raise exception 'enterprise_usage_reserve_phase_denied';end if;
 start_:=(receipt->'client_initial'->>'contract_start_at')::timestamptz;
 end_:=(receipt->'client_initial'->>'contract_end_at')::timestamptz;
 month_:=date_trunc('month',start_ at time zone 'UTC')::date;clock_:=clock_timestamp();
 while month_::timestamp at time zone 'UTC'<end_
  and(month_::timestamp+interval '1 month') at time zone 'UTC'<=clock_ loop
  if not exists(select 1 from public.enterprise_existing_usage_batches where owner_id=owner_ and service_month=month_
   and phase in('reserved','no_usage')) then exit;end if;
  steps:=steps+1;if steps>1000 then raise exception 'enterprise_usage_month_capacity_held';end if;
  month_:=(month_+interval '1 month')::date;
 end loop;
 if month_<>b.service_month or month_::timestamp at time zone 'UTC'>=end_
  or(month_::timestamp+interval '1 month') at time zone 'UTC'>clock_
  or exists(select 1 from public.enterprise_existing_usage_batches where owner_id=owner_
   and service_month<b.service_month and phase not in('reserved','no_usage'))
  then raise exception 'enterprise_usage_reserve_month_changed';end if;
 select coalesce(jsonb_agg(to_jsonb(x)-'snapshot' order by x.service_month,x.id),'[]'::jsonb) into history_
  from public.enterprise_existing_usage_batches x where x.owner_id=owner_ and x.phase in('reserved','no_usage');
 document_:=census||jsonb_build_object('version','enterprise_existing_usage_snapshot_v1','owner_id',owner_,
  'agreement_id',b.agreement_id,'receipt',receipt,'history',history_,'observed_at',b.snapshot->>'observed_at',
  'month_start',to_char(b.service_month::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'month_end',to_char(b.service_month::timestamp+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 if document_ is distinct from b.snapshot or encode(sha256(convert_to(document_::text,'UTF8')),'hex')<>b.snapshot_digest
  or clock_timestamp()>b.expires_at then raise exception 'enterprise_usage_reserve_snapshot_or_expiry_changed';end if;
 -- Structural verification of trusted-server content, NOT a SQL allocator.
 for e in select * from jsonb_array_elements(p_prefix) loop
  if jsonb_typeof(e)<>'object' or(select count(*) from jsonb_object_keys(e))<>6
   or not(e ?& array['interview_id','role_id','client_id','completed_at','source','source_id'])
   or jsonb_typeof(e->'interview_id')<>'string' or jsonb_typeof(e->'role_id')<>'string'
   or jsonb_typeof(e->'client_id')<>'string' or jsonb_typeof(e->'completed_at')<>'string'
   or jsonb_typeof(e->'source')<>'string'
   or e->>'source' not in('own','credit','pool','usage') then raise exception 'enterprise_usage_prefix_denied';end if;
  iv_id:=(e->>'interview_id')::uuid;stamp_:=(e->>'completed_at')::timestamptz;
  select x into strict iv from jsonb_array_elements(b.snapshot->'interviews')x where x->>'id'=iv_id::text;
  if iv_id=any(prefix_seen_) or stamp_ is null or not isfinite(stamp_)
   or stamp_ is distinct from(iv->>'completed_at')::timestamptz or stamp_<start_ or stamp_>=end_
   or stamp_>=(b.service_month::timestamp+interval '1 month') at time zone 'UTC'
   or e->>'role_id' is distinct from iv->>'role_id' or e->>'client_id' is distinct from iv->>'client_id'
   or(previous_ is not null and(stamp_<previous_ or(stamp_=previous_ and iv_id::text<=previous_id)))
   then raise exception 'enterprise_usage_prefix_denied';end if;
  if(e->>'source'='usage' and e->'source_id'<>'null'::jsonb)
   or(e->>'source'='own' and e->>'source_id' is distinct from e->>'role_id')
   or(e->>'source'='pool' and not exists(select 1 from jsonb_array_elements(b.snapshot->'pools')x where x->>'id'=e->>'source_id'))
   or(e->>'source'='credit' and not exists(select 1 from jsonb_array_elements(b.snapshot->'credits')x where x->>'id'=e->>'source_id'))
   then raise exception 'enterprise_usage_prefix_source_denied';end if;
  prefix_seen_:=prefix_seen_||iv_id;previous_:=stamp_;previous_id:=iv_id::text;
 end loop;
 for old_ in select * from jsonb_array_elements(history_) loop
  if exists(select 1 from jsonb_array_elements(old_->'prefix') with ordinality x(value,n)
   where x.value is distinct from p_prefix->(x.n::integer-1)) then raise exception 'enterprise_usage_prior_prefix_changed';end if;
 end loop;
 for g in select * from jsonb_array_elements(p_groups) loop
  if jsonb_typeof(g)<>'object' or(select count(*) from jsonb_object_keys(g))<>5
   or not(g ?& array['role_id','unit_price_cents','quantity','amount_cents','interview_ids'])
   or jsonb_typeof(g->'role_id')<>'string' or jsonb_typeof(g->'unit_price_cents')<>'number'
   or jsonb_typeof(g->'quantity')<>'number' or jsonb_typeof(g->'amount_cents')<>'number'
   or jsonb_typeof(g->'interview_ids')<>'array'
   or(g->>'unit_price_cents')::integer is distinct from b.unit_price_cents
   or(g->>'quantity')::integer<=0 or(g->>'quantity')::integer<>jsonb_array_length(g->'interview_ids')
   or(g->>'amount_cents')::bigint is distinct from(g->>'quantity')::bigint*b.unit_price_cents
   then raise exception 'enterprise_usage_group_denied';end if;
  role_:=(g->>'role_id')::uuid;
  if role_=any(role_seen_) then raise exception 'enterprise_usage_duplicate_role';end if;role_seen_:=role_seen_||role_;
  for iv_id in select value::uuid from jsonb_array_elements_text(g->'interview_ids') loop
   select x into strict iv from jsonb_array_elements(b.snapshot->'interviews')x where x->>'id'=iv_id::text;
   if iv_id=any(seen_) or iv->>'role_id' is distinct from role_::text
    or(iv->>'completed_at')::timestamptz<(b.service_month::timestamp at time zone 'UTC')
    or(iv->>'completed_at')::timestamptz>=((b.service_month::timestamp+interval '1 month') at time zone 'UTC')
    or not exists(select 1 from jsonb_array_elements(p_prefix)x where x->>'interview_id'=iv_id::text and x->>'source'='usage')
    then raise exception 'enterprise_usage_group_interview_denied';end if;
   seen_:=seen_||iv_id;
  end loop;
  total_:=total_+(g->>'amount_cents')::bigint;
  if total_>2147483647 then raise exception 'enterprise_usage_amount_capacity_held';end if;
 end loop;
 perform set_config('private_sales.enterprise_usage_writer',b.id::text,true);
 update public.enterprise_existing_usage_batches set phase=case when jsonb_array_length(p_groups)=0 then 'no_usage' else 'reserved' end,
  groups=p_groups,prefix=p_prefix,reserved_at=clock_timestamp() where id=b.id returning * into b;
 for g in select * from jsonb_array_elements(p_groups) loop
  insert into public.usage_billing_ledger(client_id,role_id,interview_id,unit_price_cents,period_start,period_end,enterprise_usage_batch_id)
  select b.owner_id,(g->>'role_id')::uuid,value::uuid,b.unit_price_cents,
   b.service_month::timestamp at time zone 'UTC',(b.service_month::timestamp+interval '1 month') at time zone 'UTC',b.id
   from jsonb_array_elements_text(g->'interview_ids');
 end loop;
 perform set_config('private_sales.enterprise_usage_writer','',true);
 return jsonb_build_object('phase',b.phase,'batch_id',b.id,'generation',b.generation,'total_cents',total_,
  'provider_effect_authorized',false,'paid_access_authorized',false);
end $$;
revoke all on function public.reserve_enterprise_existing_usage(uuid,integer,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_enterprise_existing_usage(uuid,integer,text,jsonb,jsonb) to service_role;

-- Complete actual native source/reservation/concurrency tests and source gate
-- remain mandatory. Neither RPC is mounted on a route, cron, or webhook.
-- Deliberately excluded from every approved/apply-able release manifest.
commit;
