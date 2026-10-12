-- Unmounted historical financial facts only. No provider writes, seeded flags,
-- Auth/client/contract/term/access/commission/collection effects or legacy writes.
begin;

create function public.membership_v2_fact_keys(p jsonb, keys text[])
returns boolean language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
 select case when jsonb_typeof(p)='object' then
  (select count(*) from jsonb_object_keys(p))=cardinality(keys)
  and not exists(select 1 from jsonb_object_keys(p) k where k<>all(keys)) else false end
$$;
create function public.membership_v2_fact_epoch(p jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,pg_temp as $$
begin
 return coalesce(jsonb_typeof(p)='number' and p::text ~ '^[0-9]+$'
  and (p::text)::bigint between 946684800 and 4102444799,false);
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;

-- A single statement reads only immutable historical provenance. Current head,
-- offboarding, gate closure and expiry cannot erase an already captured payment.
create function public.membership_v2_financial_context(p_operation uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare o public.membership_v2_checkout_operations; b public.membership_v2_checkout_bindings;
 p public.membership_v2_pending_purchases; c public.membership_v2_checkout_contexts;
 a public.membership_v2_document_acceptances; accepted_epoch bigint;
begin
 select * into o from public.membership_v2_checkout_operations where id=p_operation;
 if not found then raise exception 'financial_source_denied';end if;
 select * into b from public.membership_v2_checkout_bindings where operation_id=o.id;
 if not found then raise exception 'financial_binding_denied';end if;
 select * into p from public.membership_v2_pending_purchases where id=o.purchase_id;
 select * into c from public.membership_v2_checkout_contexts where id=o.context_id;
 select * into a from public.membership_v2_document_acceptances where document_id=p.document_id;
 -- Do not let GREATEST ignore a null acceptance. Verify the snapshot against
 -- the actual immutable acceptance row before deriving its integer bound.
 if not found or jsonb_typeof(p.source_snapshot->'acceptance'->'accepted_at') is distinct from 'string'
  or coalesce(p.source_snapshot->'acceptance'->>'accepted_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
  or not isfinite(a.accepted_at) or a.attempt_id<>p.acceptance_attempt_id
  or (p.source_snapshot->'acceptance'->>'accepted_at')::timestamptz is distinct from a.accepted_at then
  raise exception 'financial_acceptance_denied';end if;
 accepted_epoch:=floor(extract(epoch from a.accepted_at))::bigint;
 if not public.membership_v2_fact_epoch(to_jsonb(accepted_epoch)) then raise exception 'financial_acceptance_denied';end if;
 if p.id is null or c.id is null or c.environment<>p.environment
  or p.source_digest<>encode(sha256(convert_to(p.source_snapshot::text,'UTF8')),'hex')
  or o.source_digest<>p.source_digest
  or o.body_digest<>encode(sha256(convert_to(o.request_body::text,'UTF8')),'hex')
  or o.request_body is distinct from public.membership_v2_checkout_body(o.id,p.id,p.source_snapshot,c.frontend_origin,o.expires_epoch)
  or b.proof_digest<>encode(sha256(convert_to(b.proof::text,'UTF8')),'hex')
  or b.provider_account_id<>c.provider_account_id or b.livemode<>c.livemode
  or not public.membership_v2_checkout_proof_matches(o.id,b.proof) then raise exception 'financial_source_conflict';end if;
 return jsonb_build_object('operation',to_jsonb(o),'binding',to_jsonb(b),'purchase',to_jsonb(p),'context',to_jsonb(c),'accepted_epoch',accepted_epoch,
  'observed_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

create table public.membership_v2_capture_facts (
 operation_id uuid primary key references public.membership_v2_checkout_bindings(operation_id) on update restrict on delete restrict,
 purchase_id uuid not null unique references public.membership_v2_pending_purchases(id) on update restrict on delete restrict,
 source_digest text not null,
 original_salesperson_user_id uuid references public.sales_reps(user_id) on update restrict on delete restrict,
 provider_account_id text not null, livemode boolean not null, session_id text not null,
 customer_id text not null, payment_intent_id text not null, charge_id text not null,
 currency text not null check(currency='usd'), captured_cents bigint not null check(captured_cents>0),
 platform_cents bigint not null check(platform_cents>0), role_cents bigint not null check(role_cents>=0),
 proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=65536),
 proof_digest text not null, recorded_at timestamptz not null check(isfinite(recorded_at)),
 term_eligible boolean not null default false check(not term_eligible),
 owner_eligible boolean not null default false check(not owner_eligible),
 access_eligible boolean not null default false check(not access_eligible),
 commission_eligible boolean not null default false check(not commission_eligible),
 collection_eligible boolean not null default false check(not collection_eligible),
 check(captured_cents=platform_cents+role_cents),
 unique(provider_account_id,livemode,session_id), unique(provider_account_id,livemode,payment_intent_id),
 unique(provider_account_id,livemode,charge_id)
);

create function public.membership_v2_capture_proof_matches(p_operation uuid,p_proof jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare x jsonb; b jsonb; total jsonb; live jsonb; customer text;
begin
 x:=public.membership_v2_financial_context(p_operation); b:=x->'binding'->'proof';total:=b->'amount_total';live:=x->'context'->'livemode';
 if not public.membership_v2_fact_keys(p_proof,array['checkout','customer_id','payment_intent_id','charge_id',
  'intent_created','charge_created','intent_metadata','intent_status','intent_currency','intent_amount','intent_amount_received',
  'intent_customer','intent_livemode','intent_latest_charge','charge_status','charge_paid','charge_captured',
  'charge_amount','charge_amount_captured','charge_currency','charge_customer','charge_livemode','charge_payment_intent','connect']) then return false;end if;
 customer:=p_proof->>'customer_id';
 return coalesce(
  p_proof->'checkout'=(b||jsonb_build_object('status','complete','payment_status','paid'))
  and customer ~ '^cus_[A-Za-z0-9_]+$' and p_proof->>'payment_intent_id' ~ '^pi_[A-Za-z0-9_]+$'
  and p_proof->>'charge_id' ~ '^ch_[A-Za-z0-9_]+$'
  and public.membership_v2_fact_epoch(p_proof->'intent_created') and public.membership_v2_fact_epoch(p_proof->'charge_created')
  and p_proof->'intent_metadata'=x->'operation'->'request_body'->'payment_intent_data'->'metadata'
  and p_proof->>'intent_status'='succeeded' and p_proof->>'charge_status'='succeeded'
  and p_proof->'charge_paid'='true'::jsonb and p_proof->'charge_captured'='true'::jsonb
  and p_proof->>'intent_currency'='usd' and p_proof->>'charge_currency'='usd'
  and p_proof->>'intent_customer'=customer and p_proof->>'charge_customer'=customer
  and p_proof->'intent_livemode'=live and p_proof->'charge_livemode'=live
  and p_proof->>'intent_latest_charge'=p_proof->>'charge_id'
  and p_proof->>'charge_payment_intent'=p_proof->>'payment_intent_id'
  and p_proof->'intent_amount'=total and p_proof->'intent_amount_received'=total
  and p_proof->'charge_amount'=total and p_proof->'charge_amount_captured'=total
  and p_proof->'connect'='{"intent_on_behalf_of":null,"intent_transfer_data":null,"intent_application_fee_amount":null,"charge_on_behalf_of":null,"charge_transfer_data":null,"charge_application_fee":null,"charge_application_fee_amount":null,"charge_transfer":null,"charge_destination":null}'::jsonb,false);
end $$;

create function public.membership_v2_guard_capture_fact()
returns trigger language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare x jsonb; p jsonb; b jsonb;
begin
 if not public.membership_v2_capture_proof_matches(new.operation_id,new.proof) then raise exception 'capture_proof_denied';end if;
 if new.purchase_id is not null or new.source_digest is not null or new.original_salesperson_user_id is not null
  or new.provider_account_id is not null or new.livemode is not null or new.session_id is not null or new.customer_id is not null
  or new.payment_intent_id is not null or new.charge_id is not null or new.currency is not null or new.captured_cents is not null
  or new.platform_cents is not null or new.role_cents is not null or new.proof_digest is not null or new.recorded_at is not null
  or new.term_eligible or new.owner_eligible or new.access_eligible or new.commission_eligible or new.collection_eligible then
  raise exception 'capture_derived_fields_denied';end if;
 x:=public.membership_v2_financial_context(new.operation_id);p:=x->'purchase';b:=x->'binding';
 new.purchase_id:=(p->>'id')::uuid;new.source_digest:=p->>'source_digest';
 new.original_salesperson_user_id:=(p->>'original_salesperson_user_id')::uuid;
 new.provider_account_id:=b->>'provider_account_id';new.livemode:=(b->>'livemode')::boolean;new.session_id:=b->>'session_id';
 new.customer_id:=new.proof->>'customer_id';new.payment_intent_id:=new.proof->>'payment_intent_id';new.charge_id:=new.proof->>'charge_id';
 new.currency:='usd';new.captured_cents:=(b->'proof'->>'amount_total')::bigint;
 new.platform_cents:=(p->'source_snapshot'->'quote'->'offer'->>'platform_payment_cents')::bigint;
 new.role_cents:=new.captured_cents-new.platform_cents;new.proof_digest:=encode(sha256(convert_to(new.proof::text,'UTF8')),'hex');
 new.recorded_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_capture_fact before insert on public.membership_v2_capture_facts
 for each row execute function public.membership_v2_guard_capture_fact();

create table public.membership_v2_paid_invoice_facts (
 operation_id uuid primary key references public.membership_v2_capture_facts(operation_id) on update restrict on delete restrict,
 provider_account_id text not null, livemode boolean not null, invoice_id text not null,
 source_digest text not null, original_salesperson_user_id uuid,
 provider_paid_at bigint not null check(provider_paid_at between 946684800 and 4102444799),
 native_observed_at timestamptz not null check(isfinite(native_observed_at)),
 proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=65536), proof_digest text not null,
 term_eligible boolean not null default false check(not term_eligible),
 owner_eligible boolean not null default false check(not owner_eligible),
 access_eligible boolean not null default false check(not access_eligible),
 commission_eligible boolean not null default false check(not commission_eligible),
 collection_eligible boolean not null default false check(not collection_eligible),
 unique(provider_account_id,livemode,invoice_id)
);

create function public.membership_v2_invoice_proof_matches(p_operation uuid,p jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare c public.membership_v2_capture_facts; x jsonb; i jsonb; b jsonb; expected jsonb; seen text[]:=array[]::text[];
begin
 select * into c from public.membership_v2_capture_facts where operation_id=p_operation;
 if not found then return false;end if;x:=public.membership_v2_financial_context(p_operation);b:=x->'binding'->'proof';
 if not public.membership_v2_fact_keys(p,array['invoice_id','session_invoice','customer_id','payment_intent_id','charge_id','charge_invoice',
  'intent_invoice','livemode','currency','status','paid','paid_out_of_band','metadata','amount_due','amount_paid','amount_remaining','subtotal','total',
  'starting_balance','ending_balance','pre_payment_credit_notes_amount','post_payment_credit_notes_amount','discounts',
  'total_discount_amounts','total_tax_amounts','shipping_cost','subscription','created','provider_paid_at','items','has_more'])
  or coalesce(p->>'invoice_id','') !~ '^in_[A-Za-z0-9_]+$'
  or p->>'session_invoice' is distinct from p->>'invoice_id' or p->>'charge_invoice' is distinct from p->>'invoice_id'
  or (p->'intent_invoice' is distinct from 'null'::jsonb and p->>'intent_invoice' is distinct from p->>'invoice_id')
  or p->>'customer_id' is distinct from c.customer_id or p->>'payment_intent_id' is distinct from c.payment_intent_id
  or p->>'charge_id' is distinct from c.charge_id or p->'livemode' is distinct from to_jsonb(c.livemode)
  or p->>'currency' is distinct from 'usd' or p->>'status' is distinct from 'paid' or p->'paid' is distinct from 'true'::jsonb
  or p->'paid_out_of_band' is distinct from 'false'::jsonb or p->'subscription' is distinct from 'null'::jsonb
  or p->'metadata' is distinct from x->'operation'->'request_body'->'invoice_creation'->'invoice_data'->'metadata'
  or p->'amount_due' is distinct from to_jsonb(c.captured_cents) or p->'amount_paid' is distinct from to_jsonb(c.captured_cents)
  or p->'subtotal' is distinct from to_jsonb(c.captured_cents) or p->'total' is distinct from to_jsonb(c.captured_cents)
  or p->'amount_remaining' is distinct from '0'::jsonb or p->'starting_balance' is distinct from '0'::jsonb
  or p->'ending_balance' is distinct from '0'::jsonb or p->'pre_payment_credit_notes_amount' is distinct from '0'::jsonb
  or p->'post_payment_credit_notes_amount' is distinct from '0'::jsonb or p->'discounts' is distinct from '[]'::jsonb
  or p->'total_discount_amounts' is distinct from '[]'::jsonb or p->'total_tax_amounts' is distinct from '[]'::jsonb
  or p->'shipping_cost' is distinct from 'null'::jsonb or p->'has_more' is distinct from 'false'::jsonb
  or not public.membership_v2_fact_epoch(p->'created') or not public.membership_v2_fact_epoch(p->'provider_paid_at')
  or jsonb_typeof(p->'items') is distinct from 'array' then return false;end if;
 if (p->>'provider_paid_at')::bigint < greatest((x->>'accepted_epoch')::bigint,
  (b->>'created')::bigint,(c.proof->>'intent_created')::bigint,(c.proof->>'charge_created')::bigint,(p->>'created')::bigint)
  or jsonb_array_length(p->'items')<>jsonb_array_length(b->'items') then return false;end if;
 for i in select value from jsonb_array_elements(p->'items') loop
  if not public.membership_v2_fact_keys(i,array['line_id','kind','price_id','product_id','unit_amount','quantity','amount',
   'currency','price_type','recurring','metadata','name','livemode','product_livemode','type','subscription','subscription_item','discount_amounts','tax_amounts'])
   or coalesce(i->>'line_id','') !~ '^il_[A-Za-z0-9_]+$' or i->>'kind'=any(seen) then return false;end if;
  select value into expected from jsonb_array_elements(b->'items') where value->>'kind'=i->>'kind';
  if not found or i->>'price_id' is distinct from expected->>'price_id' or i->>'product_id' is distinct from expected->>'product_id'
   or i->'unit_amount' is distinct from expected->'unit_amount' or i->'quantity' is distinct from '1'::jsonb
   or i->'amount' is distinct from expected->'unit_amount' or i->>'currency' is distinct from 'usd'
   or i->>'price_type' is distinct from 'one_time' or i->'recurring' is distinct from 'null'::jsonb
   or i->'metadata' is distinct from expected->'metadata' or i->>'name' is distinct from expected->>'name'
   or i->'livemode' is distinct from to_jsonb(c.livemode) or i->'product_livemode' is distinct from to_jsonb(c.livemode)
   or i->>'type' is distinct from 'invoiceitem' or i->'subscription' is distinct from 'null'::jsonb
   or i->'subscription_item' is distinct from 'null'::jsonb or i->'discount_amounts' is distinct from '[]'::jsonb
   or i->'tax_amounts' is distinct from '[]'::jsonb then return false;end if;
  seen:=array_append(seen,i->>'kind');
 end loop;
 return (select count(distinct value->>'line_id') from jsonb_array_elements(p->'items'))=jsonb_array_length(p->'items');
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;

create function public.membership_v2_invoice_clock_ready(p_operation uuid,p jsonb)
returns boolean language plpgsql volatile security invoker set search_path=pg_catalog,pg_temp as $$
begin
 if not public.membership_v2_invoice_proof_matches(p_operation,p) then return false;end if;
 return (p->>'provider_paid_at')::bigint<=floor(extract(epoch from clock_timestamp()))::bigint;
end
$$;
create function public.membership_v2_guard_paid_invoice_fact()
returns trigger language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare c public.membership_v2_capture_facts;
begin
 if not public.membership_v2_invoice_clock_ready(new.operation_id,new.proof) then raise exception 'invoice_clock_proof_denied';end if;
 if new.provider_account_id is not null or new.livemode is not null or new.invoice_id is not null or new.source_digest is not null
  or new.original_salesperson_user_id is not null or new.provider_paid_at is not null or new.native_observed_at is not null
  or new.proof_digest is not null or new.term_eligible or new.owner_eligible or new.access_eligible or new.commission_eligible or new.collection_eligible then
  raise exception 'invoice_clock_derived_fields_denied';end if;
 select * into c from public.membership_v2_capture_facts where operation_id=new.operation_id;
 new.provider_account_id:=c.provider_account_id;new.livemode:=c.livemode;new.invoice_id:=new.proof->>'invoice_id';
 new.source_digest:=c.source_digest;new.original_salesperson_user_id:=c.original_salesperson_user_id;
 new.provider_paid_at:=(new.proof->>'provider_paid_at')::bigint;new.native_observed_at:=clock_timestamp();
 new.proof_digest:=encode(sha256(convert_to(new.proof::text,'UTF8')),'hex');return new;
end $$;
create trigger membership_v2_guard_paid_invoice_fact before insert on public.membership_v2_paid_invoice_facts
 for each row execute function public.membership_v2_guard_paid_invoice_fact();

-- Matching repeated reads preserve the first fact and native observation time.
-- No reservation for an unpaid/partial graph; no provider effect inside either RPC.
create function public.membership_v2_record_capture(p_operation uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare c public.membership_v2_capture_facts;
begin
 if not public.membership_v2_capture_proof_matches(p_operation,p_proof) then raise exception 'capture_proof_denied';end if;
 insert into public.membership_v2_capture_facts(operation_id,proof) values(p_operation,p_proof) on conflict(operation_id) do nothing;
 select * into c from public.membership_v2_capture_facts where operation_id=p_operation;
 if c.proof is distinct from p_proof then raise exception 'capture_identity_conflict';end if;
 return jsonb_build_object('operation_id',c.operation_id,'proof_digest',c.proof_digest);
end $$;
create function public.membership_v2_record_paid_invoice(p_operation uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare c public.membership_v2_paid_invoice_facts;
begin
 if not public.membership_v2_invoice_clock_ready(p_operation,p_proof) then raise exception 'invoice_clock_proof_denied';end if;
 insert into public.membership_v2_paid_invoice_facts(operation_id,proof) values(p_operation,p_proof) on conflict(operation_id) do nothing;
 select * into c from public.membership_v2_paid_invoice_facts where operation_id=p_operation;
 if c.proof is distinct from p_proof then raise exception 'invoice_clock_identity_conflict';end if;
 return jsonb_build_object('operation_id',c.operation_id,'proof_digest',c.proof_digest);
end $$;

-- Risk/reuse are observations, not ongoing truth or changes to captured money.
create table public.membership_v2_capture_observations (
 id uuid primary key default gen_random_uuid(),
 operation_id uuid not null references public.membership_v2_capture_facts(operation_id) on update restrict on delete restrict,
 observation jsonb not null check(jsonb_typeof(observation)='object' and octet_length(observation::text)<=65536),
 observed_at timestamptz not null check(isfinite(observed_at))
);
create function public.membership_v2_guard_capture_observation()
returns trigger language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare c public.membership_v2_capture_facts; p jsonb:=new.observation;
begin
 select * into c from public.membership_v2_capture_facts where operation_id=new.operation_id;
 if found and new.observed_at is null and public.membership_v2_fact_keys(p,array['kind','invoice_proof'])
  and p->>'kind'='provider_clock_ahead' and public.membership_v2_invoice_proof_matches(new.operation_id,p->'invoice_proof')
  and (p->'invoice_proof'->>'provider_paid_at')::bigint>floor(extract(epoch from clock_timestamp()))::bigint then
  new.observed_at:=clock_timestamp();return new;
 end if;
 if not found or new.observed_at is not null or not public.membership_v2_fact_keys(p,array[
  'charge_id','amount_refunded','disputed','capture_method','setup_future_usage'])
  or p->>'charge_id' is distinct from c.charge_id or jsonb_typeof(p->'amount_refunded') is distinct from 'number'
  or p->>'amount_refunded' !~ '^[0-9]+$' or (p->>'amount_refunded')::bigint>c.captured_cents
  or jsonb_typeof(p->'disputed') is distinct from 'boolean' or p->>'capture_method' not in ('automatic','automatic_async','manual')
  or p->'capture_method'='null'::jsonb or p->'setup_future_usage' not in ('null'::jsonb,'"off_session"'::jsonb,'"on_session"'::jsonb) then
  raise exception 'capture_observation_denied';end if;
 new.observed_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_capture_observation before insert on public.membership_v2_capture_observations
 for each row execute function public.membership_v2_guard_capture_observation();
create function public.membership_v2_record_capture_observation(p_operation uuid,p_observation jsonb)
returns uuid language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare result uuid;
begin
 insert into public.membership_v2_capture_observations(operation_id,observation) values(p_operation,p_observation) returning id into result;
 return result;
end $$;

do $$declare t text;begin
 foreach t in array array['membership_v2_capture_facts','membership_v2_paid_invoice_facts','membership_v2_capture_observations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
  if t='membership_v2_capture_observations' then
   execute format('grant insert(operation_id,observation) on public.%I to service_role',t);
  else execute format('grant insert(operation_id,proof) on public.%I to service_role',t);end if;
  execute format('create trigger %I before update or delete on public.%I for each row execute function public.membership_v2_reject_mutation()',t||'_immutable',t);
  execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
 end loop;
end $$;
revoke all on function public.membership_v2_fact_keys(jsonb,text[]),public.membership_v2_fact_epoch(jsonb),
 public.membership_v2_financial_context(uuid),public.membership_v2_capture_proof_matches(uuid,jsonb),public.membership_v2_guard_capture_fact(),
 public.membership_v2_invoice_proof_matches(uuid,jsonb),public.membership_v2_invoice_clock_ready(uuid,jsonb),public.membership_v2_guard_paid_invoice_fact(),public.membership_v2_record_capture(uuid,jsonb),
 public.membership_v2_record_paid_invoice(uuid,jsonb),public.membership_v2_guard_capture_observation(),public.membership_v2_record_capture_observation(uuid,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_fact_keys(jsonb,text[]),public.membership_v2_fact_epoch(jsonb),
 public.membership_v2_financial_context(uuid),public.membership_v2_capture_proof_matches(uuid,jsonb),public.membership_v2_guard_capture_fact(),
 public.membership_v2_invoice_proof_matches(uuid,jsonb),public.membership_v2_invoice_clock_ready(uuid,jsonb),public.membership_v2_guard_paid_invoice_fact(),public.membership_v2_record_capture(uuid,jsonb),
 public.membership_v2_record_paid_invoice(uuid,jsonb),public.membership_v2_guard_capture_observation(),public.membership_v2_record_capture_observation(uuid,jsonb) to service_role;
commit;
