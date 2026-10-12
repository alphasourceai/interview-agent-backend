-- Prospective signed-sales Checkout only. No seeded context/flag, hosted effect,
-- receipt, Auth/client/contract/access write, subscription or legacy mutation.
begin;

create table public.membership_v2_checkout_contexts (
 id uuid primary key default gen_random_uuid() check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 environment text not null check(environment in ('dev','qa','production')),
 provider_account_id text not null check(provider_account_id ~ '^acct_[A-Za-z0-9_]+$'),
 api_version text not null check(api_version='2023-10-16'),
 livemode boolean not null,
 frontend_origin text not null check(length(frontend_origin)<=253 and
  frontend_origin ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'),
 tax_policy text not null check(tax_policy='existing_checkout_no_automatic_tax_v1'),
 checkout_enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 check(livemode=(environment='production'))
);
create unique index membership_v2_checkout_enabled_context
 on public.membership_v2_checkout_contexts(environment) where checkout_enabled;
create function public.membership_v2_guard_checkout_context_update()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if (to_jsonb(new)-'checkout_enabled') is distinct from (to_jsonb(old)-'checkout_enabled') then
  raise exception 'immutable_checkout_context';end if;
 return new;
end $$;
create trigger membership_v2_checkout_context_update before update on public.membership_v2_checkout_contexts
 for each row execute function public.membership_v2_guard_checkout_context_update();
create trigger membership_v2_checkout_context_delete before delete on public.membership_v2_checkout_contexts
 for each row execute function public.membership_v2_reject_mutation();

create table public.membership_v2_checkout_operations (
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 purchase_id uuid not null unique references public.membership_v2_pending_purchases(id) on delete restrict on update restrict,
 context_id uuid not null references public.membership_v2_checkout_contexts(id) on delete restrict on update restrict,
 source_digest text not null,
 request_body jsonb not null check(jsonb_typeof(request_body)='object' and octet_length(request_body::text)<=32768),
 body_digest text not null check(body_digest=encode(sha256(convert_to(request_body::text,'UTF8')),'hex')),
 idempotency_key text not null unique,
 created_at timestamptz not null check(isfinite(created_at)),
 expires_epoch bigint not null check(expires_epoch>0),
 check(request_body->>'expires_at'=expires_epoch::text)
);
create table public.membership_v2_checkout_dispatches (
 operation_id uuid primary key references public.membership_v2_checkout_operations(id) on delete restrict on update restrict,
 dispatch_hash text not null check(dispatch_hash ~ '^[0-9a-f]{64}$' and dispatch_hash<>repeat('0',64)),
 claim_nonce text check(claim_nonce is null),
 started_at timestamptz not null check(isfinite(started_at))
);
create table public.membership_v2_checkout_bindings (
 operation_id uuid primary key references public.membership_v2_checkout_dispatches(operation_id) on delete restrict on update restrict,
 provider_account_id text not null,
 livemode boolean not null,
 session_id text not null check(session_id ~ '^cs_[A-Za-z0-9_]+$'),
 proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=65536),
 proof_digest text not null check(proof_digest=encode(sha256(convert_to(proof::text,'UTF8')),'hex')),
 recorded_at timestamptz not null,
 unique(provider_account_id,livemode,session_id)
);

-- Takes the existing source lock order before context SHARE. Native fresh time
-- sampled after ALL locks; a disabled context never grants fresh SDK authority.
-- SELECT FOR SHARE requires table UPDATE privilege. Do NOT grant config writes
-- to the service. This owner-only, fixed-query definer adds the lock and returns
-- only the same config row the service can already SELECT; it cannot mutate it.
do $$begin
 if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
  raise exception 'checkout_migration_owner_requires_rls_bypass';end if;
end $$;
create function public.membership_v2_lock_checkout_context(p_context uuid)
returns public.membership_v2_checkout_contexts language plpgsql security definer set search_path=pg_catalog as $$
declare c public.membership_v2_checkout_contexts;
begin
 select * into c from public.membership_v2_checkout_contexts where id=p_context for share;
 return c;
end $$;
create function public.membership_v2_checkout_context(p_purchase uuid,p_token_hash text,p_context uuid,p_current boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.membership_v2_pending_purchases; c public.membership_v2_checkout_contexts;
 s jsonb; n timestamptz; offer jsonb; expected_platform bigint;
begin
 select * into p from public.membership_v2_pending_purchases where id=p_purchase;
 if not found or p_current is null then raise exception 'checkout_source_denied';end if;
 s:=public.membership_v2_pending_source(p.document_id,p_token_hash,p_current);
 if p.source_snapshot is distinct from s->'snapshot' or p.source_digest is distinct from s->>'digest' then
  raise exception 'checkout_source_conflict';end if;
 select * into c from public.membership_v2_lock_checkout_context(p_context);
 if c.id is null or c.environment is distinct from p.environment then raise exception 'checkout_context_denied';end if;
 n:=clock_timestamp();
 if p_current and (not c.checkout_enabled or p.expires_at<=n) then raise exception 'checkout_gate_closed';end if;
 offer:=p.source_snapshot->'quote'->'offer';
 expected_platform:=case offer->>'plan_key'
  when 'basic' then case offer->>'payment_option' when 'prepaid' then
   case offer->>'commitment_months' when '3' then 120000 when '6' then 195000 when '12' then 330000 end
   when 'monthly_installments' then case offer->>'commitment_months' when '3' then 44900 when '6' then 39900 when '12' then 34900 end end
  when 'pro' then case offer->>'payment_option' when 'prepaid' then
   case offer->>'commitment_months' when '3' then 210000 when '6' then 360000 when '12' then 650000 end
   when 'monthly_installments' then case offer->>'commitment_months' when '3' then 74900 when '6' then 69900 when '12' then 64900 end end end;
 if coalesce(p.source_snapshot->'quote'->>'audience','') not in ('sales','admin')
  or not public.membership_v2_valid_offer(offer)
  or offer->>'offer_version' is distinct from 'retail-terms-2026-10-11-v1'
  or expected_platform is null or offer->'platform_payment_cents' is distinct from to_jsonb(expected_platform)
  or expected_platform not between 50 and 99999999
  or (offer->'first_role_prepay'->>'selected'='true' and (offer->'first_role_prepay'->>'amount_cents')::bigint<>
   case offer->>'plan_key' when 'basic' then 35900 when 'pro' then 62900 end) then
  raise exception 'checkout_offer_denied';end if;
 return jsonb_build_object('purchase',to_jsonb(p),'source',s,'context',to_jsonb(c),
  'observed_at',to_char(n at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

create function public.membership_v2_checkout_body(p_id uuid,p_purchase uuid,p_snapshot jsonb,p_origin text,p_expires bigint)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare o jsonb:=p_snapshot->'quote'->'offer'; m jsonb; items jsonb;
begin
 m:=jsonb_build_object('protocol','retail_checkout_v2','operation_id',p_id,'purchase_id',p_purchase,
  'document_id',p_snapshot->'document'->>'id',
  'source_digest',encode(sha256(convert_to(p_snapshot::text,'UTF8')),'hex'));
 items:=jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('currency','usd',
  'unit_amount',(o->>'platform_payment_cents')::bigint,'product_data',jsonb_build_object(
   'name',(o->>'display_name')||' platform membership — '||(o->>'commitment_months')||' months',
   'metadata',m||jsonb_build_object('kind','platform')))));
 if o->'first_role_prepay'->>'selected'='true' then
  items:=items||jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('currency','usd',
   'unit_amount',(o->'first_role_prepay'->>'amount_cents')::bigint,'product_data',jsonb_build_object(
    'name','First role prepayment (one-time; does not renew)',
    'metadata',m||jsonb_build_object('kind','first_role')))));
 end if;
 return jsonb_build_object('mode','payment','customer_creation','always',
  'customer_email',p_snapshot->'source'->'buyer'->>'buyer_email','client_reference_id',p_purchase,
  'automatic_tax',jsonb_build_object('enabled',false),'allow_promotion_codes',false,'line_items',items,'metadata',m,
  'invoice_creation',jsonb_build_object('enabled',true,'invoice_data',jsonb_build_object('metadata',m)),
  'payment_intent_data',jsonb_build_object('capture_method','automatic','setup_future_usage','off_session','metadata',m),
  'success_url',p_origin||'/membership/checkout-return?purchase_id='||p_purchase::text||'&session_id={CHECKOUT_SESSION_ID}',
  'cancel_url',p_origin||'/membership/checkout-return?purchase_id='||p_purchase::text||'&checkout=canceled',
  'expires_at',p_expires);
end $$;

-- Pure window calculator, not clock authority. Only the guard supplies the
-- locked source's actual deadline and the native after-lock observed time.
create function public.membership_v2_checkout_window(p_deadline timestamptz,p_now timestamptz)
returns bigint language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare result bigint; n bigint;
begin
 if p_deadline is null or p_now is null or not isfinite(p_deadline) or not isfinite(p_now) then
  raise exception 'checkout_window_closed';end if;
 n:=floor(extract(epoch from p_now))::bigint;
 result:=least(floor(extract(epoch from p_deadline))::bigint,n+86280);
 if result<n+1980 then raise exception 'checkout_window_closed';end if;
 return result;
end $$;

create function public.membership_v2_guard_checkout_operation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.membership_v2_pending_purchases; d public.membership_v2_issued_documents;
 ctx jsonb; n timestamptz;
begin
 select * into p from public.membership_v2_pending_purchases where id=new.purchase_id;
 if not found then raise exception 'checkout_source_denied';end if;
 select * into d from public.membership_v2_issued_documents where id=p.document_id;
 ctx:=public.membership_v2_checkout_context(p.id,d.signer_token_hash,new.context_id,true);
 if new.source_digest is not null or new.request_body is not null or new.body_digest is not null
  or new.idempotency_key is not null or new.created_at is not null or new.expires_epoch is not null then
  raise exception 'checkout_derived_fields_denied';end if;
 n:=(ctx->>'observed_at')::timestamptz;
 new.created_at:=n;new.source_digest:=p.source_digest;
 -- Leave 120 seconds below Stripe's 24h cap and above its 30m floor
 -- for the documented provider clock tolerance, plus dispatch/I/O margin.
 new.expires_epoch:=public.membership_v2_checkout_window(p.expires_at,n);
 new.request_body:=public.membership_v2_checkout_body(new.id,p.id,p.source_snapshot,ctx->'context'->>'frontend_origin',new.expires_epoch);
 new.body_digest:=encode(sha256(convert_to(new.request_body::text,'UTF8')),'hex');
 new.idempotency_key:='membership-checkout-v2:'||new.id::text;
 return new;
end $$;
create trigger membership_v2_guard_checkout_operation before insert on public.membership_v2_checkout_operations
 for each row execute function public.membership_v2_guard_checkout_operation();

create function public.membership_v2_claim_checkout_operation(p_id uuid,p_purchase uuid,p_token_hash text,p_context uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare ctx jsonb; op public.membership_v2_checkout_operations;
begin
 ctx:=public.membership_v2_checkout_context(p_purchase,p_token_hash,p_context,true);
 select * into op from public.membership_v2_checkout_operations where purchase_id=p_purchase;
 if found then
  if op.context_id<>p_context or op.source_digest is distinct from ctx->'purchase'->>'source_digest' then
   raise exception 'checkout_operation_conflict';end if;
  return jsonb_build_object('action','existing','operation_id',op.id);
 end if;
 insert into public.membership_v2_checkout_operations(id,purchase_id,context_id)
  values(p_id,p_purchase,p_context) returning * into op;
 return jsonb_build_object('action','created','operation_id',op.id);
end $$;

create function public.membership_v2_guard_checkout_dispatch()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.membership_v2_checkout_operations; p public.membership_v2_pending_purchases;
 d public.membership_v2_issued_documents; ctx jsonb; n timestamptz; hashed text;
begin
 select * into op from public.membership_v2_checkout_operations where id=new.operation_id;
 if not found then raise exception 'checkout_dispatch_denied';end if;
 select * into p from public.membership_v2_pending_purchases where id=op.purchase_id;
 select * into d from public.membership_v2_issued_documents where id=p.document_id;
 ctx:=public.membership_v2_checkout_context(p.id,d.signer_token_hash,op.context_id,true);
 n:=(ctx->>'observed_at')::timestamptz;
 if new.claim_nonce is null or new.claim_nonce !~ '^[A-Za-z0-9_-]{43}$' or new.dispatch_hash is not null
  or new.started_at is not null
  or n<op.created_at
  or op.expires_epoch<floor(extract(epoch from n))::bigint+1950 then raise exception 'checkout_dispatch_denied';end if;
 hashed:=encode(sha256(convert_to('membership-checkout-dispatch-v2'||chr(10)||op.id::text||chr(10)||op.source_digest||chr(10)||new.claim_nonce,'UTF8')),'hex');
 new.dispatch_hash:=hashed;new.claim_nonce:=null;
 new.started_at:=n;return new;
end $$;
create trigger membership_v2_guard_checkout_dispatch before insert on public.membership_v2_checkout_dispatches
 for each row execute function public.membership_v2_guard_checkout_dispatch();

create function public.membership_v2_claim_checkout_dispatch(p_operation uuid,p_token_hash text,p_nonce text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.membership_v2_checkout_operations; ctx jsonb;
begin
 select * into op from public.membership_v2_checkout_operations where id=p_operation;
 if not found or p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'checkout_dispatch_denied';end if;
 ctx:=public.membership_v2_checkout_context(op.purchase_id,p_token_hash,op.context_id,true);
 -- A fresh capability-authorized call can claim the SAME immutable operation
 -- while no dispatch exists. The permanent PK admits ONE winner; its in-memory
 -- nonce proves that winner on separate post-COMMIT readback. An existing
 -- marker's hash is NEVER sufficient SDK authority after ambiguous ACK.
 insert into public.membership_v2_checkout_dispatches(operation_id,claim_nonce) values(op.id,p_nonce);
 return jsonb_build_object('action','dispatch_claimed','operation_id',op.id);
end $$;

-- Compact service attestation, independently matched to native request. SQL is
-- NOT authentication of Stripe; only the reviewed private SDK port supplies it.
create function public.membership_v2_checkout_proof_matches(p_operation uuid,p_proof jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.membership_v2_checkout_operations; ctx public.membership_v2_checkout_contexts;
 dispatch public.membership_v2_checkout_dispatches; item jsonb; expected jsonb; seen text[]:=array[]::text[];
begin
 select * into op from public.membership_v2_checkout_operations where id=p_operation;
 if not found then return false;end if;
 select * into ctx from public.membership_v2_checkout_contexts where id=op.context_id;
 select * into dispatch from public.membership_v2_checkout_dispatches where operation_id=op.id;
 if not found or jsonb_typeof(p_proof) is distinct from 'object' or octet_length(p_proof::text)>65536 then return false;end if;
 if (select count(*) from jsonb_object_keys(p_proof))<>25
  or exists(select 1 from jsonb_object_keys(p_proof) key where key<>all(array[
   'session_id','provider_account_id','livemode','api_version','mode','currency','customer_creation','customer_email',
   'client_reference_id','metadata','success_url','cancel_url','expires_at','automatic_tax_enabled','amount_discount',
   'amount_tax','amount_shipping','has_more','status','payment_status','created','items','amount_subtotal','amount_total','invoice_metadata']))
  or coalesce(p_proof->>'session_id','') !~ '^cs_[A-Za-z0-9_]+$'
  or p_proof->>'provider_account_id' is distinct from ctx.provider_account_id
  or p_proof->'livemode' is distinct from to_jsonb(ctx.livemode)
  or p_proof->>'api_version' is distinct from ctx.api_version
  or p_proof->>'mode' is distinct from 'payment' or p_proof->>'currency' is distinct from 'usd'
  or p_proof->>'customer_creation' is distinct from 'always'
  or p_proof->>'customer_email' is distinct from op.request_body->>'customer_email'
  or p_proof->>'client_reference_id' is distinct from op.purchase_id::text
  or p_proof->'metadata' is distinct from op.request_body->'metadata'
  or p_proof->'invoice_metadata' is distinct from op.request_body->'invoice_creation'->'invoice_data'->'metadata'
  or p_proof->>'success_url' is distinct from op.request_body->>'success_url'
  or p_proof->>'cancel_url' is distinct from op.request_body->>'cancel_url'
  or p_proof->'expires_at' is distinct from to_jsonb(op.expires_epoch)
  or p_proof->'automatic_tax_enabled' is distinct from 'false'::jsonb
  or p_proof->'amount_discount' is distinct from '0'::jsonb or p_proof->'amount_tax' is distinct from '0'::jsonb
  or p_proof->'amount_shipping' is distinct from '0'::jsonb
  or p_proof->'has_more' is distinct from 'false'::jsonb
  or p_proof->>'status' is distinct from 'open' or p_proof->>'payment_status' is distinct from 'unpaid'
  or jsonb_typeof(p_proof->'created') is distinct from 'number' or p_proof->>'created' !~ '^[0-9]+$'
  or (p_proof->>'created')::bigint<floor(extract(epoch from dispatch.started_at))::bigint-120
  or (p_proof->>'created')::bigint>floor(extract(epoch from dispatch.started_at))::bigint+130
  or jsonb_typeof(p_proof->'items') is distinct from 'array'
  or jsonb_array_length(p_proof->'items')<>jsonb_array_length(op.request_body->'line_items') then return false;end if;
 for item in select value from jsonb_array_elements(p_proof->'items') loop
  if jsonb_typeof(item) is distinct from 'object' then return false;end if;
  if (select count(*) from jsonb_object_keys(item))<>15
   or exists(select 1 from jsonb_object_keys(item) key where key<>all(array['kind','line_id','price_id','product_id',
    'metadata','name','unit_amount','amount_subtotal','amount_total','quantity','currency','price_type','recurring','amount_discount','amount_tax']))
   or item->>'kind' is null or item->>'kind'=any(seen) or coalesce(item->>'line_id','') !~ '^li_[A-Za-z0-9_]+$'
   or coalesce(item->>'price_id','') !~ '^price_[A-Za-z0-9_]+$' or coalesce(item->>'product_id','') !~ '^prod_[A-Za-z0-9_]+$' then return false;end if;
  select value into expected from jsonb_array_elements(op.request_body->'line_items')
   where value->'price_data'->'product_data'->'metadata'->>'kind'=item->>'kind';
  if not found or item->'metadata' is distinct from expected->'price_data'->'product_data'->'metadata'
   or item->>'name' is distinct from expected->'price_data'->'product_data'->>'name'
   or item->'unit_amount' is distinct from expected->'price_data'->'unit_amount'
   or item->'amount_subtotal' is distinct from item->'unit_amount' or item->'amount_total' is distinct from item->'unit_amount'
   or item->'quantity' is distinct from '1'::jsonb or item->>'currency' is distinct from 'usd'
   or item->>'price_type' is distinct from 'one_time' or item->'recurring' is distinct from 'null'::jsonb
   or item->'amount_discount' is distinct from '0'::jsonb or item->'amount_tax' is distinct from '0'::jsonb then return false;end if;
  seen:=array_append(seen,item->>'kind');
 end loop;
 if p_proof->'amount_subtotal' is distinct from to_jsonb((select sum((value->'price_data'->>'unit_amount')::bigint)::bigint
   from jsonb_array_elements(op.request_body->'line_items')))
  or p_proof->'amount_total' is distinct from p_proof->'amount_subtotal'
  or (select count(distinct value->>'line_id') from jsonb_array_elements(p_proof->'items'))<>jsonb_array_length(p_proof->'items')
  or (select count(distinct value->>'price_id') from jsonb_array_elements(p_proof->'items'))<>jsonb_array_length(p_proof->'items')
  or (select count(distinct value->>'product_id') from jsonb_array_elements(p_proof->'items'))<>jsonb_array_length(p_proof->'items') then return false;end if;
 return true;
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;

create function public.membership_v2_guard_checkout_binding()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.membership_v2_checkout_operations; ctx public.membership_v2_checkout_contexts;
begin
 select * into op from public.membership_v2_checkout_operations where id=new.operation_id;
 if not found or not public.membership_v2_checkout_proof_matches(op.id,new.proof) then raise exception 'checkout_binding_denied';end if;
 select * into ctx from public.membership_v2_checkout_contexts where id=op.context_id;
 if new.provider_account_id is not null or new.livemode is not null or new.session_id is not null
  or new.proof_digest is not null or new.recorded_at is not null then raise exception 'checkout_derived_fields_denied';end if;
 new.provider_account_id:=ctx.provider_account_id;new.livemode:=ctx.livemode;new.session_id:=new.proof->>'session_id';
 new.proof_digest:=encode(sha256(convert_to(new.proof::text,'UTF8')),'hex');new.recorded_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_checkout_binding before insert on public.membership_v2_checkout_bindings
 for each row execute function public.membership_v2_guard_checkout_binding();

create function public.membership_v2_bind_checkout(p_operation uuid,p_token_hash text,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.membership_v2_checkout_operations; ctx jsonb; binding public.membership_v2_checkout_bindings;
begin
 select * into op from public.membership_v2_checkout_operations where id=p_operation;
 if not found then raise exception 'checkout_binding_denied';end if;
 -- Record known external identity even if gate closed AFTER dispatch. This is
 -- historical identity, NOT permission to return a URL, collect or activate.
 ctx:=public.membership_v2_checkout_context(op.purchase_id,p_token_hash,op.context_id,false);
 select * into binding from public.membership_v2_checkout_bindings where operation_id=op.id;
 if found then
  if binding.proof is distinct from p_proof then raise exception 'checkout_binding_conflict';end if;
  return jsonb_build_object('action','existing','operation_id',op.id,'session_id',binding.session_id);
 end if;
 insert into public.membership_v2_checkout_bindings(operation_id,proof) values(op.id,p_proof) returning * into binding;
 return jsonb_build_object('action','bound','operation_id',op.id,'session_id',binding.session_id);
end $$;

do $$declare t text;begin
 foreach t in array array['membership_v2_checkout_contexts','membership_v2_checkout_operations',
  'membership_v2_checkout_dispatches','membership_v2_checkout_bindings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
  execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
  if t<>'membership_v2_checkout_contexts' then
   execute format('grant insert on public.%I to service_role',t);
   execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
  end if;
 end loop;
end $$;
revoke all on function public.membership_v2_lock_checkout_context(uuid),public.membership_v2_guard_checkout_context_update(),public.membership_v2_checkout_context(uuid,text,uuid,boolean),
 public.membership_v2_checkout_body(uuid,uuid,jsonb,text,bigint),public.membership_v2_checkout_window(timestamptz,timestamptz),public.membership_v2_guard_checkout_operation(),
 public.membership_v2_claim_checkout_operation(uuid,uuid,text,uuid),public.membership_v2_guard_checkout_dispatch(),
 public.membership_v2_claim_checkout_dispatch(uuid,text,text),public.membership_v2_checkout_proof_matches(uuid,jsonb),
 public.membership_v2_guard_checkout_binding(),public.membership_v2_bind_checkout(uuid,text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_lock_checkout_context(uuid),public.membership_v2_checkout_context(uuid,text,uuid,boolean),
 public.membership_v2_checkout_body(uuid,uuid,jsonb,text,bigint),public.membership_v2_checkout_window(timestamptz,timestamptz),public.membership_v2_guard_checkout_operation(),
 public.membership_v2_claim_checkout_operation(uuid,uuid,text,uuid),public.membership_v2_guard_checkout_dispatch(),
 public.membership_v2_claim_checkout_dispatch(uuid,text,text),public.membership_v2_checkout_proof_matches(uuid,jsonb),
 public.membership_v2_guard_checkout_binding(),public.membership_v2_bind_checkout(uuid,text,jsonb) to service_role;
commit;
