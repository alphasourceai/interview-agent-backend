-- DRAFT ONLY. Do not apply to production. Incomplete forward migration.
-- Pending full catalog reconciliation, PostgreSQL 17.4 rehearsal, and Grok exact-candidate review.
-- No production rows, lines, roster, or existing constraint definitions are changed here.

-- QA source: outbox migration; selected for production-specific draft.
-- Durable, service-role-only outbox for sales integration side effects.
-- Payment activation only enqueues an event. A bounded worker claims rows with
-- SKIP LOCKED so Slack or CRM availability never controls customer activation.

alter table public.public_purchase_intents
  add column if not exists sales_won_enqueued_at timestamptz;

create table if not exists public.sales_integration_deliveries (
  id uuid primary key default gen_random_uuid(),
  integration text not null,
  event_type text not null,
  event_key text not null,
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  delivered_at timestamptz,
  external_message_id text,
  external_channel_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_integration_deliveries_integration_check
    check (integration in ('slack', 'ghl')),
  constraint sales_integration_deliveries_event_type_length
    check (char_length(event_type) between 1 and 80),
  constraint sales_integration_deliveries_event_key_length
    check (char_length(event_key) between 1 and 240),
  constraint sales_integration_deliveries_status_check
    check (status in ('pending', 'processing', 'retry', 'delivered', 'failed')),
  constraint sales_integration_deliveries_attempt_count_check
    check (attempt_count >= 0 and max_attempts between 1 and 25)
);

create unique index if not exists sales_integration_deliveries_event_uidx
  on public.sales_integration_deliveries (integration, event_type, event_key);

create index if not exists sales_integration_deliveries_due_idx
  on public.sales_integration_deliveries (next_attempt_at, created_at)
  where status in ('pending', 'retry');

create index if not exists sales_integration_deliveries_intent_idx
  on public.sales_integration_deliveries (purchase_intent_id, created_at desc);

alter table public.sales_integration_deliveries enable row level security;
revoke all on table public.sales_integration_deliveries from public, anon, authenticated;
revoke all on table public.sales_integration_deliveries from service_role;
grant select, insert, update on table public.sales_integration_deliveries to service_role;

create or replace function public.claim_sales_integration_deliveries(
  p_limit integer default 10,
  p_lock_token uuid default gen_random_uuid(),
  p_now timestamptz default now(),
  p_integration text default null
)
returns setof public.sales_integration_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sales_integration_deliveries as exhausted
  set status = 'failed',
      locked_at = null,
      lock_token = null,
      last_error = coalesce(exhausted.last_error, 'delivery_worker_interrupted'),
      updated_at = p_now
  where exhausted.status = 'processing'
    and exhausted.locked_at < p_now - interval '10 minutes'
    and exhausted.attempt_count >= exhausted.max_attempts
    and (p_integration is null or exhausted.integration = p_integration);

  return query
  with candidates as (
    select delivery.id
    from public.sales_integration_deliveries as delivery
    where (p_integration is null or delivery.integration = p_integration)
    and ((
      delivery.status in ('pending', 'retry')
      and delivery.next_attempt_at <= p_now
      and delivery.attempt_count < delivery.max_attempts
    ) or (
      delivery.status = 'processing'
      and delivery.locked_at < p_now - interval '10 minutes'
      and delivery.attempt_count < delivery.max_attempts
    ))
    order by delivery.next_attempt_at asc, delivery.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.sales_integration_deliveries as delivery
  set status = 'processing',
      attempt_count = delivery.attempt_count + 1,
      locked_at = p_now,
      lock_token = p_lock_token,
      updated_at = p_now
  from candidates
  where delivery.id = candidates.id
  returning delivery.*;
end;
$$;

revoke all on function public.claim_sales_integration_deliveries(integer, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_sales_integration_deliveries(integer, uuid, timestamptz, text) to service_role;

-- QA source: GHL sales integration migration; selected for production-specific draft.
-- GHL CRM <-> alphaScreen sales close integration.
-- Every object is server-only. Browser callers must use authenticated Express
-- routes, and provider webhooks may only submit opaque identifiers that the
-- backend re-fetches from GHL before making a state transition.

create table if not exists public.ghl_sales_deal_bindings (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  contact_id text not null,
  opportunity_id text not null,
  pipeline_id text not null,
  ready_stage_id text not null,
  provider_owner_user_id text not null,
  sales_team_member_id uuid references public.sales_team_members(id) on delete restrict,
  sales_rep_user_id uuid references public.sales_reps(user_id) on delete restrict,
  purchase_intent_id uuid unique references public.public_purchase_intents(id) on delete restrict,
  status text not null default 'ready',
  company_name text,
  contact_first_name text,
  contact_last_name text,
  contact_email text,
  contact_phone text,
  contact_title text,
  opportunity_name text,
  opportunity_source text,
  provider_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  linked_at timestamptz,
  won_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_detail text,
  manual_review_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ghl_sales_deal_bindings_provider_ids_check check (
    char_length(location_id) between 3 and 160
    and char_length(contact_id) between 3 and 160
    and char_length(opportunity_id) between 3 and 160
    and char_length(pipeline_id) between 3 and 160
    and char_length(ready_stage_id) between 3 and 160
    and char_length(provider_owner_user_id) between 3 and 160
  ),
  constraint ghl_sales_deal_bindings_status_check check (
    status in ('ready', 'linked', 'won_pending', 'won', 'exception', 'detached')
  ),
  constraint ghl_sales_deal_bindings_company_length check (company_name is null or char_length(company_name) <= 160),
  constraint ghl_sales_deal_bindings_contact_name_length check (
    (contact_first_name is null or char_length(contact_first_name) <= 80)
    and (contact_last_name is null or char_length(contact_last_name) <= 80)
  ),
  constraint ghl_sales_deal_bindings_contact_email_length check (contact_email is null or char_length(contact_email) <= 254),
  constraint ghl_sales_deal_bindings_contact_phone_length check (contact_phone is null or char_length(contact_phone) <= 40),
  constraint ghl_sales_deal_bindings_contact_title_length check (contact_title is null or char_length(contact_title) <= 120),
  constraint ghl_sales_deal_bindings_opportunity_length check (
    (opportunity_name is null or char_length(opportunity_name) <= 200)
    and (opportunity_source is null or char_length(opportunity_source) <= 120)
  ),
  constraint ghl_sales_deal_bindings_error_length check (
    (last_error_code is null or char_length(last_error_code) <= 80)
    and (last_error_detail is null or char_length(last_error_detail) <= 500)
  )
);

create unique index if not exists ghl_sales_deal_bindings_opportunity_uidx
  on public.ghl_sales_deal_bindings (location_id, opportunity_id);

create index if not exists ghl_sales_deal_bindings_rep_status_idx
  on public.ghl_sales_deal_bindings (sales_rep_user_id, status, imported_at desc);

create index if not exists ghl_sales_deal_bindings_contact_idx
  on public.ghl_sales_deal_bindings (location_id, contact_id, imported_at desc);

create table if not exists public.ghl_sales_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  body_sha256 text not null,
  location_id text,
  opportunity_id text,
  event_type text not null default 'ready_to_close',
  status text not null default 'processing',
  attempt_count integer not null default 1,
  binding_id uuid references public.ghl_sales_deal_bindings(id) on delete set null,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_detail text,
  constraint ghl_sales_webhook_receipts_event_key_length check (char_length(event_key) between 8 and 255),
  constraint ghl_sales_webhook_receipts_digest_check check (body_sha256 ~ '^[a-f0-9]{64}$'),
  constraint ghl_sales_webhook_receipts_status_check check (status in ('processing', 'completed', 'failed')),
  constraint ghl_sales_webhook_receipts_attempt_check check (attempt_count between 1 and 100),
  constraint ghl_sales_webhook_receipts_error_length check (
    (last_error_code is null or char_length(last_error_code) <= 80)
    and (last_error_detail is null or char_length(last_error_detail) <= 500)
  )
);

create index if not exists ghl_sales_webhook_receipts_status_received_idx
  on public.ghl_sales_webhook_receipts (status, last_received_at desc);

create table if not exists public.ghl_sales_sync_events (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid references public.ghl_sales_deal_bindings(id) on delete restrict,
  purchase_intent_id uuid references public.public_purchase_intents(id) on delete restrict,
  direction text not null,
  event_type text not null,
  idempotency_key text not null unique,
  status text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  constraint ghl_sales_sync_events_direction_check check (direction in ('inbound', 'outbound', 'admin')),
  constraint ghl_sales_sync_events_status_check check (status in ('received', 'ignored', 'completed', 'failed', 'retrying', 'manual_review')),
  constraint ghl_sales_sync_events_type_length check (char_length(event_type) between 1 and 80),
  constraint ghl_sales_sync_events_idempotency_length check (char_length(idempotency_key) between 8 and 255),
  constraint ghl_sales_sync_events_metadata_object check (jsonb_typeof(safe_metadata) = 'object'),
  constraint ghl_sales_sync_events_error_length check (
    (error_code is null or char_length(error_code) <= 80)
    and (error_detail is null or char_length(error_detail) <= 500)
  )
);

create index if not exists ghl_sales_sync_events_binding_created_idx
  on public.ghl_sales_sync_events (binding_id, created_at desc);

alter table public.sales_integration_deliveries
  add column if not exists manual_review_required boolean not null default false;

alter table public.ghl_sales_deal_bindings enable row level security;
alter table public.ghl_sales_webhook_receipts enable row level security;
alter table public.ghl_sales_sync_events enable row level security;

revoke all on table public.ghl_sales_deal_bindings from public, anon, authenticated;
revoke all on table public.ghl_sales_webhook_receipts from public, anon, authenticated;
revoke all on table public.ghl_sales_sync_events from public, anon, authenticated;
revoke all on table public.ghl_sales_deal_bindings from service_role;
revoke all on table public.ghl_sales_webhook_receipts from service_role;
revoke all on table public.ghl_sales_sync_events from service_role;

grant select, insert, update on table public.ghl_sales_deal_bindings to service_role;
grant select, insert, update on table public.ghl_sales_webhook_receipts to service_role;
grant select, insert on table public.ghl_sales_sync_events to service_role;

create or replace function public.claim_ghl_sales_binding(
  p_binding_id uuid,
  p_purchase_intent_id uuid,
  p_sales_rep_user_id uuid,
  p_claimed_at timestamptz default now()
)
returns public.ghl_sales_deal_bindings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_binding public.ghl_sales_deal_bindings;
begin
  update public.ghl_sales_deal_bindings as binding
  set purchase_intent_id = p_purchase_intent_id,
      status = case when binding.status = 'won' then 'won' else 'linked' end,
      linked_at = coalesce(binding.linked_at, p_claimed_at),
      last_error_code = null,
      last_error_detail = null,
      manual_review_required = false,
      updated_at = p_claimed_at
  where binding.id = p_binding_id
    and binding.sales_rep_user_id = p_sales_rep_user_id
    and binding.status in ('ready', 'linked')
    and (binding.purchase_intent_id is null or binding.purchase_intent_id = p_purchase_intent_id)
  returning binding.* into v_binding;

  if v_binding.id is null then
    raise exception using errcode = 'P0001', message = 'ghl_sales_binding_not_claimable';
  end if;

  return v_binding;
end;
$$;

revoke all on function public.claim_ghl_sales_binding(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_ghl_sales_binding(uuid, uuid, uuid, timestamptz)
  to service_role;

create or replace function public.list_missing_ghl_sales_won_intents(
  p_limit integer default 100
)
returns table (id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select intent.id
  from public.public_purchase_intents as intent
  join public.ghl_sales_deal_bindings as binding
    on binding.purchase_intent_id = intent.id
   and binding.opportunity_id = intent.ghl_opportunity_id
   and binding.contact_id = intent.ghl_contact_id
   and binding.status in ('linked', 'won_pending', 'won')
   and binding.manual_review_required = false
  join public.membership_agreements as agreement
    on agreement.id = intent.agreement_id
   and agreement.status = 'signed'
   and agreement.checkout_status = 'paid'
   and agreement.checkout_paid_at is not null
  join public.clients as client
    on client.id = intent.client_id
   and client.billing_status = 'active'
   and coalesce(nullif(lower(btrim(client.subscription_status)), ''), 'active') in ('active', 'trialing')
  where intent.channel = 'sales_assisted'
    and intent.status = 'completed'
    and intent.activated_at is not null
    and intent.ghl_opportunity_id is not null
    and not exists (
      select 1
      from public.sales_integration_deliveries as delivery
      where delivery.purchase_intent_id = intent.id
        and delivery.integration = 'ghl'
        and delivery.event_type = 'sales_won'
    )
  order by intent.activated_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

revoke all on function public.list_missing_ghl_sales_won_intents(integer)
  from public, anon, authenticated;
grant execute on function public.list_missing_ghl_sales_won_intents(integer)
  to service_role;

-- QA source: shared voice routing migration, without QA row-seeding UPDATE.
-- Route all four company sales lines through one reusable Grok Voice entrypoint.
-- GHL records the line reached before forwarding the call. The shared agent then
-- exchanges the caller number for a short-lived, single-use routing reference.

alter table public.sales_phone_numbers
  add column if not exists shared_voice_entrypoint boolean not null default false,
  add column if not exists handoff_token_sha256 text;

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.sales_phone_numbers'::regclass
                   and conname = 'sales_phone_numbers_handoff_token_check') then
    alter table public.sales_phone_numbers
      add constraint sales_phone_numbers_handoff_token_check
      check (handoff_token_sha256 is null or handoff_token_sha256 ~ '^[a-f0-9]{64}$');
  end if;
end $$;

create unique index if not exists sales_phone_numbers_handoff_token_uidx
  on public.sales_phone_numbers (handoff_token_sha256)
  where handoff_token_sha256 is not null;

create unique index if not exists sales_phone_numbers_single_shared_voice_entrypoint_uidx
  on public.sales_phone_numbers (shared_voice_entrypoint)
  where shared_voice_entrypoint = true;

-- No production line row is assigned or changed by this migration.

create table if not exists public.sales_voice_route_events (
  id uuid primary key default gen_random_uuid(),
  phone_number_id uuid not null references public.sales_phone_numbers(id) on delete restrict,
  caller_phone_e164 text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  constraint sales_voice_route_events_caller_phone_check check (caller_phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  constraint sales_voice_route_events_expiry_check check (expires_at > created_at)
);

create index if not exists sales_voice_route_events_lookup_idx
  on public.sales_voice_route_events (caller_phone_e164, created_at desc);

create table if not exists public.sales_voice_call_contexts (
  id uuid primary key default gen_random_uuid(),
  route_event_id uuid not null unique references public.sales_voice_route_events(id) on delete cascade,
  assignment_id uuid not null references public.sales_phone_assignments(id) on delete restrict,
  token_sha256 text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  claimed_at timestamptz,
  constraint sales_voice_call_contexts_token_check check (token_sha256 ~ '^[a-f0-9]{64}$'),
  constraint sales_voice_call_contexts_expiry_check check (expires_at > created_at),
  constraint sales_voice_call_contexts_claim_check check (claimed_at is null or claimed_at >= created_at)
);

create index if not exists sales_voice_call_contexts_active_idx
  on public.sales_voice_call_contexts (token_sha256)
  where claimed_at is null;

alter table public.sales_voice_route_events enable row level security;
alter table public.sales_voice_call_contexts enable row level security;
revoke all on table public.sales_voice_route_events from public, anon, authenticated;
revoke all on table public.sales_voice_call_contexts from public, anon, authenticated;
revoke all on table public.sales_voice_route_events from service_role;
revoke all on table public.sales_voice_call_contexts from service_role;
grant select, insert, update, delete on table public.sales_voice_route_events to service_role;
grant select, insert, update, delete on table public.sales_voice_call_contexts to service_role;

create or replace function public.record_sales_voice_route(
  p_phone_number_id uuid,
  p_caller_phone_e164 text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  if p_caller_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'sales_voice_caller_phone_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_caller_phone_e164, 0));
  if not exists (
    select 1
    from public.sales_phone_assignments
    where phone_number_id = p_phone_number_id and status = 'active'
  ) then
    raise exception 'sales_voice_line_unassigned';
  end if;
  delete from public.sales_voice_call_contexts where expires_at <= now();
  delete from public.sales_voice_route_events as route
  where route.expires_at <= now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id and context.expires_at > now()
    );
  select route.id into v_event_id
  from public.sales_voice_route_events as route
  where route.phone_number_id = p_phone_number_id
    and route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    )
  order by route.created_at desc
  limit 1
  for update;
  if found then return v_event_id; end if;
  insert into public.sales_voice_route_events (phone_number_id, caller_phone_e164)
  values (p_phone_number_id, p_caller_phone_e164)
  returning id into v_event_id;
  return v_event_id;
end;
$$;

create or replace function public.create_sales_voice_call_context(
  p_caller_phone_e164 text,
  p_token_sha256 text
)
returns table (assignment_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.sales_voice_route_events%rowtype;
  v_event_count integer;
  v_assignment_id uuid;
begin
  if p_caller_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'sales_voice_caller_phone_invalid';
  end if;
  if p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_context_token_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_caller_phone_e164, 0));
  select count(*) into v_event_count
  from public.sales_voice_route_events as route
  where route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    );
  if v_event_count = 0 then raise exception 'sales_voice_route_not_found'; end if;
  if v_event_count > 1 then raise exception 'sales_voice_route_ambiguous'; end if;
  select route.* into v_event
  from public.sales_voice_route_events as route
  where route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    )
  for update;
  if not found then raise exception 'sales_voice_route_not_found'; end if;

  select assignment.id into v_assignment_id
  from public.sales_phone_assignments as assignment
  join public.sales_team_members as member on member.id = assignment.team_member_id
  where assignment.phone_number_id = v_event.phone_number_id
    and assignment.status = 'active'
    and member.status = 'active'
  for update of assignment;
  if not found then raise exception 'sales_voice_route_unavailable'; end if;

  insert into public.sales_voice_call_contexts (route_event_id, assignment_id, token_sha256)
  values (v_event.id, v_assignment_id, p_token_sha256);
  return query select v_assignment_id;
end;
$$;

create or replace function public.claim_sales_voice_call_context(
  p_token_sha256 text
)
returns table (assignment_id uuid, caller_phone_e164 text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_context_token_invalid';
  end if;
  return query
  with claimed as (
    update public.sales_voice_call_contexts as context
    set claimed_at = now()
    where context.token_sha256 = p_token_sha256
      and context.claimed_at is null
      and context.expires_at > now()
    returning context.assignment_id, context.route_event_id
  )
  select claimed.assignment_id, route.caller_phone_e164
  from claimed
  join public.sales_voice_route_events as route on route.id = claimed.route_event_id;
end;
$$;

revoke all on function public.record_sales_voice_route(uuid, text) from public, anon, authenticated;
revoke all on function public.create_sales_voice_call_context(text, text) from public, anon, authenticated;
revoke all on function public.claim_sales_voice_call_context(text) from public, anon, authenticated;
grant execute on function public.record_sales_voice_route(uuid, text) to service_role;
grant execute on function public.create_sales_voice_call_context(text, text) to service_role;
grant execute on function public.claim_sales_voice_call_context(text) to service_role;

-- QA source: sales completion migration, fields only and no constraint DROP.
alter table public.sales_reps
  add column if not exists slack_user_id text null;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sales_reps'::regclass and conname = 'sales_reps_slack_user_id_check') then
    alter table public.sales_reps
      add constraint sales_reps_slack_user_id_check
      check (slack_user_id is null or slack_user_id ~ '^[UW][A-Z0-9]{8,20}$');
  end if;
end $$;

alter table public.public_purchase_intents
  add column if not exists sales_rep_slack_enqueued_at timestamptz null;

alter table public.sales_deal_previews
  add column if not exists agreement_effective_date date null,
  add column if not exists agreement_renewal_date date null,
  add column if not exists agreement_expires_at timestamptz null;

alter table public.membership_agreements
  add column if not exists agreement_expires_at timestamptz null;

revoke all on table public.sales_reps from public, anon, authenticated;
grant select on table public.sales_reps to service_role;

-- The production control-plane tables already exist but did not grant the
-- backend service role access. Grant only the operations used by the new sales
-- workspace; do not alter anon/authenticated privileges on these tables.
grant select, insert on table public.sales_deal_events to service_role;
grant select, insert, update on table public.sales_deal_previews to service_role;
grant select, insert on table public.sales_enterprise_handoffs to service_role;
grant select, insert, update, delete on table public.sales_idempotency_keys to service_role;

-- QA source: stripe activation recovery migration, cancellation/replacement RPCs only.
-- These are required by sales actions; retail activation/fence RPCs are not copied.
create or replace function public.cancel_sales_assisted_purchase(
  p_intent_id uuid,
  p_agreement_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement_updated integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  update public.public_purchase_intents
  set status = 'canceled',
      canceled_at = v_now,
      activation_claimed_at = null,
      activation_claim_key = null,
      updated_at = v_now
  where id = p_intent_id
    and created_by_user_id = p_user_id
    and channel = 'sales_assisted'
    and agreement_id is not distinct from p_agreement_id
    and status not in ('completed', 'canceled')
    and activated_at is null
    and (activation_claimed_at is null
      or activation_claimed_at < v_now - interval '5 minutes')
  returning * into v_intent;
  if not found then
    return jsonb_build_object('status', 'refused');
  end if;

  if p_agreement_id is not null then
    update public.membership_agreements
    set status = 'voided',
        is_current = false,
        updated_at = v_now
    where id = p_agreement_id
      and coalesce(checkout_status, '') <> 'paid'
      and superseded_by_agreement_id is null;
    get diagnostics v_agreement_updated = row_count;
    if v_agreement_updated <> 1 then
      raise exception using errcode = 'P0001', message = 'sales_agreement_not_cancelable';
    end if;
  end if;
  return jsonb_build_object('status', 'canceled', 'intent', to_jsonb(v_intent));
end;
$$;

create or replace function public.replace_sales_assisted_agreement(
  p_intent_id uuid,
  p_old_agreement_id uuid,
  p_new_agreement_id uuid,
  p_new_expires_at timestamptz,
  p_replaced_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent_updated integer := 0;
  v_agreement_updated integer := 0;
begin
  update public.public_purchase_intents
  set agreement_id = p_new_agreement_id,
      status = 'agreement_pending',
      expires_at = p_new_expires_at,
      stripe_checkout_session_id = null,
      term_start_basis = 'agreement_date',
      activation_claimed_at = null,
      activation_claim_key = null,
      updated_at = p_replaced_at
  where id = p_intent_id
    and channel = 'sales_assisted'
    and agreement_id = p_old_agreement_id
    and status <> 'completed'
    and activated_at is null
    and (activation_claimed_at is null
      or activation_claimed_at < clock_timestamp() - interval '5 minutes');
  get diagnostics v_intent_updated = row_count;
  if v_intent_updated <> 1 then return false; end if;

  update public.membership_agreements
  set status = 'superseded',
      is_current = false,
      superseded_at = p_replaced_at,
      superseded_by_agreement_id = p_new_agreement_id,
      updated_at = p_replaced_at
  where id = p_old_agreement_id
    and status in ('sent', 'signed')
    and coalesce(checkout_status, '') <> 'paid';
  get diagnostics v_agreement_updated = row_count;
  if v_agreement_updated <> 1 then
    raise exception using errcode = 'P0001', message = 'sales_agreement_not_replaceable';
  end if;

  update public.membership_agreements
  set status = 'sent', sent_at = p_replaced_at, updated_at = p_replaced_at
  where id = p_new_agreement_id and status = 'draft';
  if not found then
    raise exception using errcode = 'P0001', message = 'sales_replacement_not_ready';
  end if;
  return true;
end;
$$;

revoke all on function public.cancel_sales_assisted_purchase(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.cancel_sales_assisted_purchase(uuid, uuid, uuid) to service_role;
grant execute on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;
