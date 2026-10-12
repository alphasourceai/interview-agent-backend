-- Passive prospective intent ONLY. No provider execution/payment/access.
begin;

alter table public.client_interview_pools add column if not exists checkout_operation_id uuid;

create table public.enterprise_v2_checkout_operations (
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 agreement_id uuid not null unique references public.membership_agreements(id) on delete restrict,
 pool_id uuid not null unique references public.client_interview_pools(id) on delete restrict deferrable initially deferred,
 client_id uuid not null references public.clients(id) on delete restrict,
 billing_owner_user_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check(environment in('dev','staging','production')),
 expected_provider_account_id text not null check(expected_provider_account_id ~ '^acct_[A-Za-z0-9_]+$'),
 expected_livemode boolean not null,
 expected_customer_id text not null check(expected_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
 request_key_hash text not null check(request_key_hash ~ '^[0-9a-f]{64}$'),
 -- Real branded HTML includes the inline logo (~234KB). Bound the complete
 -- frozen source at 1MiB rather than excluding any accepted document fields.
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object' and octet_length(source_snapshot::text)<=1048576),
 source_digest text not null check(source_digest=encode(pg_catalog.sha256(convert_to(source_snapshot::text,'UTF8')),'hex')),
 pool_offer_snapshot jsonb not null check(public.enterprise_pool_v2_valid_offer(pool_offer_snapshot)),
 pool_offer_digest text not null check(pool_offer_digest=public.enterprise_pool_v2_offer_digest(pool_offer_snapshot)),
 platform_cents integer not null check(platform_cents>0),
 platform_interval text not null check(platform_interval in('month','year')),
 calendar_anchor_at timestamptz not null check(isfinite(calendar_anchor_at)),
 created_at timestamptz not null check(isfinite(created_at)),
 expires_at timestamptz not null check(isfinite(expires_at) and expires_at=created_at+interval '1 hour' and expires_at<calendar_anchor_at),
 checkout_creation_authorized boolean not null default false check(checkout_creation_authorized=false),
 provider_binding_verified boolean not null default false check(provider_binding_verified=false),
 source_artifacts_verified boolean not null default false check(source_artifacts_verified=false),
 credits_spendable boolean not null default false check(credits_spendable=false),
 check((environment='production')=expected_livemode),
 check(pool_id<>'00000000-0000-0000-0000-000000000000'::uuid and pool_id<>id),
 check(agreement_id<>'00000000-0000-0000-0000-000000000000'::uuid
  and client_id<>'00000000-0000-0000-0000-000000000000'::uuid
  and billing_owner_user_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 unique(environment,billing_owner_user_id,request_key_hash)
);
create index enterprise_v2_checkout_client_idx on public.enterprise_v2_checkout_operations(client_id);
create index enterprise_v2_checkout_owner_idx on public.enterprise_v2_checkout_operations(billing_owner_user_id);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='enterprise_v2_pool_operation_fk' and conrelid='public.client_interview_pools'::regclass) then
  alter table public.client_interview_pools add constraint enterprise_v2_pool_operation_fk
   foreign key(checkout_operation_id) references public.enterprise_v2_checkout_operations(id) on delete restrict;
 end if;
end $$;
create unique index enterprise_v2_pool_operation_unique on public.client_interview_pools(checkout_operation_id) where checkout_operation_id is not null;

-- No new auth/table read privileges: missing native access fails closed.
-- Locks native Auth -> client -> member -> agreement; no network under locks.
create function public.enterprise_v2_reservation_source(p_agreement uuid,p_owner uuid,p_customer text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements%rowtype; u jsonb; c public.clients%rowtype;
 v jsonb; s jsonb; ex jsonb; snapshot jsonb; fields jsonb; signature jsonb;
 owner_client uuid; n timestamptz:=clock_timestamp(); fee numeric; f text;
begin
 if current_user<>'service_role' then raise exception 'enterprise_reservation_server_only';end if;
 if p_agreement is null or p_owner is null or p_customer is null
  or p_agreement='00000000-0000-0000-0000-000000000000'::uuid or p_owner='00000000-0000-0000-0000-000000000000'::uuid
  then raise exception 'enterprise_reservation_scope_denied';end if;
 select client_id into owner_client from public.membership_agreements where id=p_agreement;
 select to_jsonb(t) into u from auth.users t where t.id=p_owner for share;
 if u is null or u->>'is_anonymous' is distinct from 'false' or jsonb_typeof(u->'is_anonymous') is distinct from 'boolean'
  or u->>'deleted_at' is not null or not coalesce(isfinite((u->>'email_confirmed_at')::timestamptz),false)
  or (u->>'email_confirmed_at')::timestamptz>n
  or (u->>'banned_until' is not null and (u->>'banned_until')::timestamptz>n)
  or coalesce(length(btrim(u->>'email')),0)=0 then raise exception 'enterprise_reservation_scope_denied';end if;
 select * into c from public.clients where id=owner_client for share;
 if not found or c.parent_client_id is not null or c.archived_at is not null or c.stripe_customer_id is distinct from p_customer
  then raise exception 'enterprise_reservation_scope_denied';end if;
 perform 1 from public.client_members m where m.client_id=c.id and m.role in('manager','admin','owner','super_admin')
  and coalesce(nullif(to_jsonb(m)->>'user_id_uuid',''),to_jsonb(m)->>'user_id')=p_owner::text
  and (nullif(to_jsonb(m)->>'user_id_uuid','') is null or nullif(to_jsonb(m)->>'user_id','') is null
   or to_jsonb(m)->>'user_id_uuid'=to_jsonb(m)->>'user_id') for share;
 if not found then raise exception 'enterprise_reservation_scope_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id or a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.membership_tier is distinct from 'enterprise' or not coalesce(isfinite(a.signed_at),false) or a.signed_at>n
  or a.signer_accepted is distinct from true or coalesce(length(btrim(a.signer_typed_name)),0)=0
  or coalesce(a.signature_sha256,'') !~ '^[0-9a-f]{64}$'
  or coalesce(length(btrim(a.signature_image_path)),0)=0 or coalesce(length(btrim(a.executed_pdf_path)),0)=0
  or lower(btrim(a.admin_email)) is distinct from lower(btrim(u->>'email'))
  or not coalesce(isfinite(a.agreement_expires_at),false) or a.agreement_expires_at<=n
  then raise exception 'enterprise_reservation_source_denied';end if;
 v:=a.template_snapshot->'values';s:=v->'pool_offer_snapshot';ex:=a.template_snapshot->'execution';
 if not coalesce(public.enterprise_pool_v2_valid_offer(s),false)
  or v->>'pool_offer_digest' is distinct from public.enterprise_pool_v2_offer_digest(s)
  or v->>'membership_tier' is distinct from 'enterprise' or v->>'billing_model' is distinct from 'usage'
  or v->>'pool_discount_priced' is distinct from 'true'
  or (s->>'net_cents')::integer<=0 or (v->>'pool_quantity')::numeric is distinct from(s->>'quantity')::numeric
  or (v->>'usage_interview_fee_cents')::numeric is distinct from(s->>'unit_price_cents')::numeric
  or (v->>'pool_discount_pct')::numeric is distinct from(s->>'automatic_discount_percent')::numeric
  or (v->>'pool_total_cents')::numeric is distinct from(s->>'net_cents')::numeric
  or a.billing_option not in('monthly','annual') or jsonb_typeof(ex) is distinct from 'object'
  or ex->'signer_accepted' is distinct from 'true'::jsonb
  or (ex->>'signed_at')::timestamptz is distinct from a.signed_at
  or ex->>'signer_typed_name' is distinct from a.signer_typed_name
  or ex->>'signature_image_path' is distinct from a.signature_image_path
  or ex->>'signature_sha256' is distinct from a.signature_sha256
  or ex->>'executed_pdf_path' is distinct from a.executed_pdf_path
  or ex->>'signer_ip' is distinct from a.signer_ip or ex->>'signer_user_agent' is distinct from a.signer_user_agent
  then raise exception 'enterprise_reservation_source_denied';end if;
 if jsonb_typeof(v->'platform_fee') not in('number','string') or coalesce(v->>'platform_fee','') !~ '^[0-9]+(\.[0-9]{1,2})?$'
  then raise exception 'enterprise_reservation_price_denied';end if;
 fee:=(v->>'platform_fee')::numeric*100;
 if fee not between 1 and 2147483647 then raise exception 'enterprise_reservation_price_denied';end if;
 fields:='{}';signature:='{}';
 foreach f in array array['id','client_id','client_legal_name','dba_trade_name','primary_admin_name','admin_email','membership_tier',
  'initial_term_start','initial_renewal_date','billing_option','auto_renew','notice_deadline_days','template_version','draft_pdf_path',
  'created_by_user_id','created_by_email','created_at','agreement_expires_at'] loop fields:=fields||jsonb_build_object(f,to_jsonb(a)->f);end loop;
 foreach f in array array['signed_at','signer_typed_name','signer_accepted','signature_image_path','signature_sha256',
  'signer_ip','signer_user_agent','executed_pdf_path'] loop signature:=signature||jsonb_build_object(f,to_jsonb(a)->f);end loop;
 -- Native timestamptz JSON rendering otherwise depends on session TimeZone.
 -- Normalize native timestamps, not the original frozen document's text.
 fields:=fields||jsonb_build_object('created_at',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'agreement_expires_at',to_char(a.agreement_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 signature:=signature||jsonb_build_object('signed_at',to_char(a.signed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 snapshot:=jsonb_build_object('protocol','enterprise_signed_source_v2','document_fields',fields,'signature_fields',signature,'template_snapshot',a.template_snapshot);
 if octet_length(snapshot::text)>1048576 then raise exception 'enterprise_reservation_source_denied';end if;
 return jsonb_build_object('source_snapshot',snapshot,'client_id',c.id,'pool_offer_snapshot',s,'pool_offer_digest',v->>'pool_offer_digest',
  'platform_cents',fee::integer,'platform_interval',case when a.billing_option='annual' then 'year' else 'month' end,
  'source_expires_at',a.agreement_expires_at);
end $$;

create function public.enterprise_v2_guard_checkout_operation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare s jsonb;n timestamptz;
begin
 if TG_OP<>'INSERT' then raise exception 'enterprise_reservation_immutable';end if;
 s:=public.enterprise_v2_reservation_source(new.agreement_id,new.billing_owner_user_id,new.expected_customer_id);
 n:=date_trunc('second',clock_timestamp());
 new.client_id:=(s->>'client_id')::uuid;new.source_snapshot:=s->'source_snapshot';
 new.source_digest:=encode(pg_catalog.sha256(convert_to(new.source_snapshot::text,'UTF8')),'hex');
 new.pool_offer_snapshot:=s->'pool_offer_snapshot';new.pool_offer_digest:=s->>'pool_offer_digest';
 new.platform_cents:=(s->>'platform_cents')::integer;new.platform_interval:=s->>'platform_interval';
 new.created_at:=n;new.expires_at:=n+interval '1 hour';
 new.calendar_anchor_at:=(date_trunc('month',n at time zone 'UTC')+interval '1 month') at time zone 'UTC';
 if new.expires_at>(s->>'source_expires_at')::timestamptz or new.expires_at>=new.calendar_anchor_at
  then raise exception 'enterprise_reservation_window_denied';end if;
 if new.checkout_creation_authorized is distinct from false or new.provider_binding_verified is distinct from false
  or new.source_artifacts_verified is distinct from false or new.credits_spendable is distinct from false
  then raise exception 'enterprise_reservation_no_authority';end if;return new;
end $$;
create trigger enterprise_v2_guard_checkout_operation before insert or update or delete on public.enterprise_v2_checkout_operations
 for each row execute function public.enterprise_v2_guard_checkout_operation();
create trigger enterprise_v2_checkout_no_truncate before truncate on public.enterprise_v2_checkout_operations
 for each statement execute function public.enterprise_v2_guard_checkout_operation();

create function public.enterprise_v2_guard_pool_operation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare o public.enterprise_v2_checkout_operations%rowtype;
begin
 if TG_OP='DELETE' then if old.checkout_operation_id is not null then raise exception 'enterprise_reservation_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if new.checkout_operation_id is distinct from old.checkout_operation_id then raise exception 'enterprise_reservation_pool_backfill_denied';end if;
  if old.checkout_operation_id is not null and(new.stripe_checkout_session_id,new.stripe_payment_intent_id,new.paid_at)
    is distinct from(old.stripe_checkout_session_id,old.stripe_payment_intent_id,old.paid_at) then raise exception 'enterprise_reservation_no_authority';end if;
  if old.checkout_operation_id is not null and
   (new.status not in('pending','failed','voided') or new.status is null
    or (old.status in('failed','voided') and new.status is distinct from old.status))
   then raise exception 'enterprise_reservation_pool_terminal';end if;
  return new;
 end if;
 if new.checkout_operation_id is null then return new;end if;
 select * into o from public.enterprise_v2_checkout_operations where id=new.checkout_operation_id;
 if not found or (new.id,new.client_id,new.offer_snapshot,new.offer_digest,new.quantity_purchased,new.unit_price_cents,new.discount_pct,new.total_cents)
  is distinct from(o.pool_id,o.client_id,o.pool_offer_snapshot,o.pool_offer_digest,(o.pool_offer_snapshot->>'quantity')::integer,
   (o.pool_offer_snapshot->>'unit_price_cents')::integer,(o.pool_offer_snapshot->>'automatic_discount_percent')::numeric,(o.pool_offer_snapshot->>'net_cents')::integer)
  or new.status is distinct from 'pending' or new.stripe_checkout_session_id is not null or new.stripe_payment_intent_id is not null or new.paid_at is not null
  then raise exception 'enterprise_reservation_pool_denied';end if;
 new.created_at:=o.created_at;return new;
end $$;
create trigger enterprise_v2_guard_pool_operation before insert or update or delete on public.client_interview_pools
 for each row execute function public.enterprise_v2_guard_pool_operation();

create function public.enterprise_v2_check_operation_pool()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.client_interview_pools%rowtype;
begin
 select * into p from public.client_interview_pools where id=new.pool_id;
 if not found or(p.checkout_operation_id,p.client_id,p.offer_snapshot,p.offer_digest,p.created_at,p.status)
  is distinct from(new.id,new.client_id,new.pool_offer_snapshot,new.pool_offer_digest,new.created_at,'pending'::text)
  or p.stripe_checkout_session_id is not null or p.stripe_payment_intent_id is not null or p.paid_at is not null
  then raise exception 'enterprise_reservation_pool_denied';end if;return new;
end $$;
create constraint trigger enterprise_v2_check_operation_pool after insert on public.enterprise_v2_checkout_operations
 deferrable initially deferred for each row execute function public.enterprise_v2_check_operation_pool();

create function public.enterprise_v2_reserve_checkout(p_id uuid,p_pool uuid,p_agreement uuid,p_owner uuid,
 p_environment text,p_account text,p_mode boolean,p_customer text,p_key_hash text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s jsonb;o public.enterprise_v2_checkout_operations%rowtype;p public.client_interview_pools%rowtype;
begin
 s:=public.enterprise_v2_reservation_source(p_agreement,p_owner,p_customer);
 -- The locked agreement serializes same-source contenders; native unique key
 -- handles simultaneous different-source/same-key conflicts transactionally.
 select * into o from public.enterprise_v2_checkout_operations where agreement_id=p_agreement;
 if found then
  if(o.billing_owner_user_id,o.environment,o.expected_provider_account_id,o.expected_livemode,o.expected_customer_id,o.request_key_hash,o.source_snapshot)
   is distinct from(p_owner,p_environment,p_account,p_mode,p_customer,p_key_hash,s->'source_snapshot')
   or o.expires_at<=clock_timestamp() then raise exception 'enterprise_reservation_conflict';end if;
  select * into p from public.client_interview_pools where id=o.pool_id and checkout_operation_id=o.id for share;
  if not found or(p.client_id,p.offer_snapshot,p.offer_digest,p.created_at,p.status)
   is distinct from(o.client_id,o.pool_offer_snapshot,o.pool_offer_digest,o.created_at,'pending'::text)
   or p.stripe_checkout_session_id is not null or p.stripe_payment_intent_id is not null or p.paid_at is not null
   then raise exception 'enterprise_reservation_conflict';end if;
  return jsonb_build_object('action','already_reserved','operation_id',o.id,'pool_id',o.pool_id);
 end if;
 insert into public.enterprise_v2_checkout_operations(id,pool_id,agreement_id,billing_owner_user_id,environment,
  expected_provider_account_id,expected_livemode,expected_customer_id,request_key_hash)
 values(p_id,p_pool,p_agreement,p_owner,p_environment,p_account,p_mode,p_customer,p_key_hash) returning * into o;
 insert into public.client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,discount_pct,total_cents,status,
  offer_snapshot,offer_digest,checkout_operation_id)
 values(o.pool_id,o.client_id,(o.pool_offer_snapshot->>'quantity')::integer,(o.pool_offer_snapshot->>'unit_price_cents')::integer,
  (o.pool_offer_snapshot->>'automatic_discount_percent')::integer,(o.pool_offer_snapshot->>'net_cents')::integer,'pending',
  o.pool_offer_snapshot,o.pool_offer_digest,o.id);
 return jsonb_build_object('action','reserved','operation_id',o.id,'pool_id',o.pool_id);
end $$;

-- Readback is a native scoped READ, not a second reservation/mutation. It
-- rechecks current Auth/member/parent/customer/source while recovering an ACK.
create function public.enterprise_v2_read_checkout(p_agreement uuid,p_owner uuid,p_environment text,
 p_account text,p_mode boolean,p_customer text,p_key_hash text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s jsonb;o public.enterprise_v2_checkout_operations%rowtype;p public.client_interview_pools%rowtype;
begin
 s:=public.enterprise_v2_reservation_source(p_agreement,p_owner,p_customer);
 select * into o from public.enterprise_v2_checkout_operations where agreement_id=p_agreement and billing_owner_user_id=p_owner
  and environment=p_environment and expected_provider_account_id=p_account and expected_livemode=p_mode
  and expected_customer_id=p_customer and request_key_hash=p_key_hash;
 if not found or o.source_snapshot is distinct from s->'source_snapshot' or o.expires_at<=clock_timestamp()
  then raise exception 'enterprise_reservation_readback_denied';end if;
 select * into p from public.client_interview_pools where id=o.pool_id and checkout_operation_id=o.id;
 if not found or(p.client_id,p.offer_snapshot,p.offer_digest,p.created_at,p.status)
  is distinct from(o.client_id,o.pool_offer_snapshot,o.pool_offer_digest,o.created_at,'pending'::text)
  or p.stripe_checkout_session_id is not null or p.stripe_payment_intent_id is not null or p.paid_at is not null
  then raise exception 'enterprise_reservation_readback_denied';end if;
 return jsonb_build_object('operation',to_jsonb(o),'pool',to_jsonb(p));
end $$;

alter table public.enterprise_v2_checkout_operations enable row level security;
revoke all on public.enterprise_v2_checkout_operations from public,anon,authenticated,service_role;
grant select,insert on public.enterprise_v2_checkout_operations to service_role;
revoke all on function public.enterprise_v2_reservation_source(uuid,uuid,text),public.enterprise_v2_guard_checkout_operation(),
 public.enterprise_v2_guard_pool_operation(),public.enterprise_v2_check_operation_pool(),
 public.enterprise_v2_reserve_checkout(uuid,uuid,uuid,uuid,text,text,boolean,text,text),
 public.enterprise_v2_read_checkout(uuid,uuid,text,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.enterprise_v2_reservation_source(uuid,uuid,text),public.enterprise_v2_guard_checkout_operation(),
 public.enterprise_v2_guard_pool_operation(),public.enterprise_v2_check_operation_pool(),
 public.enterprise_v2_reserve_checkout(uuid,uuid,uuid,uuid,text,text,boolean,text,text),
 public.enterprise_v2_read_checkout(uuid,uuid,text,text,boolean,text,text) to service_role;
commit;
