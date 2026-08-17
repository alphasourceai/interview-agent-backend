begin;

create table if not exists private_auth.sms_line_type_cache (
  destination_fingerprint text primary key check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  line_type text not null check (line_type in ('mobile', 'landline', 'voip', 'unknown')),
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (expires_at > checked_at)
);

create table if not exists private_auth.sms_spend_reservations (
  reservation_id uuid primary key,
  period_day date not null,
  reserved_cents integer not null check (reserved_cents between 1 and 100000),
  provider text not null check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  country text not null check (country ~ '^[A-Z]{2}$'),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  resource_fingerprint text not null check (resource_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text null check (outcome is null or outcome in (
    'accepted', 'ambiguous_outcome', 'provider_rejected', 'invalid_destination',
    'blocked_destination', 'transient_preacceptance', 'misconfigured'
  )),
  released_at timestamptz null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create index if not exists sms_spend_reservations_active_day_idx
  on private_auth.sms_spend_reservations (period_day, provider, created_at)
  where released_at is null;

create table if not exists private_auth.sms_inbound_control_events (
  inbound_event_id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  action text not null check (action in ('stop', 'start', 'help')),
  provider_event_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (provider, provider_event_id)
);

create table if not exists private_auth.sms_provider_breakers (
  provider text primary key check (provider ~ '^[a-z0-9_:-]{1,40}$'),
  active boolean not null default true,
  reason text not null check (reason in ('provider_spend_limit', 'admin_blocked')),
  source_event_id text null check (source_event_id is null or char_length(source_event_id) between 1 and 255),
  activated_at timestamptz not null default statement_timestamp(),
  released_at timestamptz null,
  updated_at timestamptz not null default statement_timestamp(),
  check ((active and released_at is null) or (not active and released_at is not null))
);

alter table private_auth.sms_line_type_cache enable row level security;
alter table private_auth.sms_spend_reservations enable row level security;
alter table private_auth.sms_inbound_control_events enable row level security;
alter table private_auth.sms_provider_breakers enable row level security;

alter table private_auth.sms_line_type_cache owner to postgres;
alter table private_auth.sms_spend_reservations owner to postgres;
alter table private_auth.sms_inbound_control_events owner to postgres;
alter table private_auth.sms_provider_breakers owner to postgres;

revoke all on table private_auth.sms_line_type_cache from public, anon, authenticated, service_role;
revoke all on table private_auth.sms_spend_reservations from public, anon, authenticated, service_role;
revoke all on table private_auth.sms_inbound_control_events from public, anon, authenticated, service_role;
revoke all on table private_auth.sms_provider_breakers from public, anon, authenticated, service_role;

comment on table private_auth.sms_line_type_cache is
  'Private, fingerprint-only cache of provider line-type results. No raw phone values are stored.';
comment on table private_auth.sms_spend_reservations is
  'Atomic conservative SMS spend reservations used by the alphaScreen global production breaker.';
comment on table private_auth.sms_inbound_control_events is
  'Deduplicated signed STOP, START, and HELP control events keyed without plaintext phone values.';
comment on table private_auth.sms_provider_breakers is
  'Provider-level emergency SMS circuit breakers, including provider spend-limit events.';

create or replace function private_auth.get_sms_line_type_cache(
  p_destination_fingerprint text,
  p_provider text
)
returns table(line_type text, checked_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $function$
  select c.line_type, c.checked_at, c.expires_at
  from private_auth.sms_line_type_cache c
  where p_destination_fingerprint ~ '^[0-9a-f]{64}$'
    and p_provider ~ '^[a-z0-9_:-]{1,40}$'
    and c.destination_fingerprint = p_destination_fingerprint
    and c.provider = p_provider
    and c.expires_at > statement_timestamp()
$function$;

create or replace function private_auth.put_sms_line_type_cache(
  p_destination_fingerprint text,
  p_provider text,
  p_line_type text,
  p_checked_at timestamptz,
  p_ttl_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_provider !~ '^[a-z0-9_:-]{1,40}$'
    or p_line_type not in ('mobile', 'landline', 'voip', 'unknown')
    or p_checked_at is null
    or p_ttl_seconds not between 3600 and 2678400
  then
    raise exception using errcode = '22023', message = 'invalid sms line type cache input';
  end if;

  insert into private_auth.sms_line_type_cache (
    destination_fingerprint, provider, line_type, checked_at, expires_at, created_at, updated_at
  ) values (
    p_destination_fingerprint, p_provider, p_line_type, p_checked_at,
    p_checked_at + pg_catalog.make_interval(secs => p_ttl_seconds),
    statement_timestamp(), statement_timestamp()
  )
  on conflict (destination_fingerprint) do update
  set provider = excluded.provider,
      line_type = excluded.line_type,
      checked_at = excluded.checked_at,
      expires_at = excluded.expires_at,
      updated_at = statement_timestamp();
end
$function$;

create or replace function private_auth.reserve_sms_spend(
  p_reservation_id uuid,
  p_reserved_cents integer,
  p_daily_cap_cents integer,
  p_provider text,
  p_country text,
  p_destination_fingerprint text,
  p_candidate_id uuid,
  p_resource_fingerprint text
)
returns table(allowed boolean, reserved_total_cents integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period_day date := (statement_timestamp() at time zone 'UTC')::date;
  v_total bigint;
begin
  if p_reservation_id is null
    or p_reserved_cents not between 1 and 100000
    or p_daily_cap_cents not between p_reserved_cents and 10000000
    or p_provider !~ '^[a-z0-9_:-]{1,40}$'
    or p_country !~ '^[A-Z]{2}$'
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_candidate_id is null
    or p_resource_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'invalid sms spend reservation input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sms-spend' || chr(31) || p_provider || chr(31) || v_period_day::text, 0)
  );

  if exists (
    select 1 from private_auth.sms_provider_breakers b
    where b.provider = p_provider and b.active = true
  ) then
    return query select false, 0;
    return;
  end if;

  select coalesce(sum(r.reserved_cents), 0)
  into v_total
  from private_auth.sms_spend_reservations r
  where r.period_day = v_period_day
    and r.provider = p_provider
    and r.released_at is null;

  if v_total + p_reserved_cents > p_daily_cap_cents then
    return query select false, v_total::integer;
    return;
  end if;

  insert into private_auth.sms_spend_reservations (
    reservation_id, period_day, reserved_cents, provider, country,
    destination_fingerprint, candidate_id, resource_fingerprint
  ) values (
    p_reservation_id, v_period_day, p_reserved_cents, p_provider, p_country,
    p_destination_fingerprint, p_candidate_id, p_resource_fingerprint
  );

  return query select true, (v_total + p_reserved_cents)::integer;
end
$function$;

create or replace function private_auth.release_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows integer;
begin
  if p_reservation_id is null or p_outcome not in (
    'provider_rejected', 'invalid_destination', 'blocked_destination',
    'transient_preacceptance', 'misconfigured'
  ) then
    raise exception using errcode = '22023', message = 'invalid sms spend release input';
  end if;

  update private_auth.sms_spend_reservations
  set released_at = statement_timestamp(), outcome = p_outcome, updated_at = statement_timestamp()
  where reservation_id = p_reservation_id and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

create or replace function private_auth.finalize_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows integer;
begin
  if p_reservation_id is null or p_outcome not in ('accepted', 'ambiguous_outcome') then
    raise exception using errcode = '22023', message = 'invalid sms spend finalization input';
  end if;
  update private_auth.sms_spend_reservations
  set outcome = p_outcome, updated_at = statement_timestamp()
  where reservation_id = p_reservation_id and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

create or replace function private_auth.record_sms_inbound_control_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_destination_fingerprint text,
  p_action text
)
returns table(applied boolean, replayed boolean, suppressed boolean, released boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inserted_rows integer;
  v_released boolean := false;
  v_released_rows integer := 0;
begin
  if p_provider !~ '^[a-z0-9_:-]{1,40}$'
    or coalesce(p_provider_event_id, '') = ''
    or char_length(p_provider_event_id) > 255
    or p_provider_event_at is null
    or p_destination_fingerprint !~ '^[0-9a-f]{64}$'
    or p_action not in ('stop', 'start', 'help')
  then
    raise exception using errcode = '22023', message = 'invalid sms inbound control event';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sms-control' || chr(31) || p_destination_fingerprint, 0)
  );

  insert into private_auth.sms_inbound_control_events (
    provider, provider_event_id, destination_fingerprint, action, provider_event_at
  ) values (
    p_provider, p_provider_event_id, p_destination_fingerprint, p_action, p_provider_event_at
  ) on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted_rows = row_count;

  if v_inserted_rows = 0 then
    return query select false, true,
      private_auth.is_sms_destination_suppressed(p_destination_fingerprint, 'authentication'), false;
    return;
  end if;

  if p_action = 'stop' then
    if not exists (
      select 1 from private_auth.sms_destination_suppressions s
      where s.destination_fingerprint = p_destination_fingerprint
        and s.scope = 'authentication' and s.released_at is null
    ) then
      insert into private_auth.sms_destination_suppressions (
        destination_fingerprint, scope, status, reason, source, source_event_id
      ) values (
        p_destination_fingerprint, 'authentication', 'opted_out',
        'Recipient opted out by text message', p_provider || ':webhook', p_provider_event_id
      );
    end if;
  elsif p_action = 'start' then
    update private_auth.sms_destination_suppressions
    set released_at = statement_timestamp(), updated_at = statement_timestamp()
    where destination_fingerprint = p_destination_fingerprint
      and scope = 'authentication' and status = 'opted_out' and released_at is null;
    get diagnostics v_released_rows = row_count;
    v_released := v_released_rows > 0;
  end if;

  return query select true, false,
    private_auth.is_sms_destination_suppressed(p_destination_fingerprint, 'authentication'), v_released;
end
$function$;

create or replace function private_auth.activate_sms_provider_breaker(
  p_provider text,
  p_source_event_id text,
  p_activated_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_provider !~ '^[a-z0-9_:-]{1,40}$'
    or coalesce(p_source_event_id, '') = ''
    or char_length(p_source_event_id) > 255
    or p_activated_at is null
  then
    raise exception using errcode = '22023', message = 'invalid sms provider breaker event';
  end if;
  insert into private_auth.sms_provider_breakers (
    provider, active, reason, source_event_id, activated_at, released_at, updated_at
  ) values (
    p_provider, true, 'provider_spend_limit', p_source_event_id, p_activated_at, null, statement_timestamp()
  ) on conflict (provider) do update
  set active = true,
      reason = 'provider_spend_limit',
      source_event_id = excluded.source_event_id,
      activated_at = excluded.activated_at,
      released_at = null,
      updated_at = statement_timestamp();
end
$function$;

create or replace function public.service_get_sms_line_type_cache(
  p_destination_fingerprint text,
  p_provider text
)
returns table(line_type text, checked_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = ''
as $function$
  select * from private_auth.get_sms_line_type_cache(p_destination_fingerprint, p_provider)
$function$;

create or replace function public.service_put_sms_line_type_cache(
  p_destination_fingerprint text,
  p_provider text,
  p_line_type text,
  p_checked_at timestamptz,
  p_ttl_seconds integer
)
returns void language sql volatile security definer set search_path = ''
as $function$
  select private_auth.put_sms_line_type_cache(
    p_destination_fingerprint, p_provider, p_line_type, p_checked_at, p_ttl_seconds
  )
$function$;

create or replace function public.service_reserve_sms_spend(
  p_reservation_id uuid,
  p_reserved_cents integer,
  p_daily_cap_cents integer,
  p_provider text,
  p_country text,
  p_destination_fingerprint text,
  p_candidate_id uuid,
  p_resource_fingerprint text
)
returns table(allowed boolean, reserved_total_cents integer)
language sql volatile security definer set search_path = ''
as $function$
  select * from private_auth.reserve_sms_spend(
    p_reservation_id, p_reserved_cents, p_daily_cap_cents, p_provider, p_country,
    p_destination_fingerprint, p_candidate_id, p_resource_fingerprint
  )
$function$;

create or replace function public.service_release_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean language sql volatile security definer set search_path = ''
as $function$ select private_auth.release_sms_spend(p_reservation_id, p_outcome) $function$;

create or replace function public.service_finalize_sms_spend(
  p_reservation_id uuid,
  p_outcome text
)
returns boolean language sql volatile security definer set search_path = ''
as $function$ select private_auth.finalize_sms_spend(p_reservation_id, p_outcome) $function$;

create or replace function public.service_record_sms_inbound_control_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_destination_fingerprint text,
  p_action text
)
returns table(applied boolean, replayed boolean, suppressed boolean, released boolean)
language sql volatile security definer set search_path = ''
as $function$
  select * from private_auth.record_sms_inbound_control_event(
    p_provider, p_provider_event_id, p_provider_event_at, p_destination_fingerprint, p_action
  )
$function$;

create or replace function public.service_activate_sms_provider_breaker(
  p_provider text,
  p_source_event_id text,
  p_activated_at timestamptz
)
returns void language sql volatile security definer set search_path = ''
as $function$
  select private_auth.activate_sms_provider_breaker(p_provider, p_source_event_id, p_activated_at)
$function$;

alter function private_auth.get_sms_line_type_cache(text,text) owner to postgres;
alter function private_auth.put_sms_line_type_cache(text,text,text,timestamptz,integer) owner to postgres;
alter function private_auth.reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) owner to postgres;
alter function private_auth.release_sms_spend(uuid,text) owner to postgres;
alter function private_auth.finalize_sms_spend(uuid,text) owner to postgres;
alter function private_auth.record_sms_inbound_control_event(text,text,timestamptz,text,text) owner to postgres;
alter function private_auth.activate_sms_provider_breaker(text,text,timestamptz) owner to postgres;
alter function public.service_get_sms_line_type_cache(text,text) owner to postgres;
alter function public.service_put_sms_line_type_cache(text,text,text,timestamptz,integer) owner to postgres;
alter function public.service_reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) owner to postgres;
alter function public.service_release_sms_spend(uuid,text) owner to postgres;
alter function public.service_finalize_sms_spend(uuid,text) owner to postgres;
alter function public.service_record_sms_inbound_control_event(text,text,timestamptz,text,text) owner to postgres;
alter function public.service_activate_sms_provider_breaker(text,text,timestamptz) owner to postgres;

revoke all on function private_auth.get_sms_line_type_cache(text,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.put_sms_line_type_cache(text,text,text,timestamptz,integer) from public, anon, authenticated, service_role;
revoke all on function private_auth.reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.release_sms_spend(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.finalize_sms_spend(uuid,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.record_sms_inbound_control_event(text,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function private_auth.activate_sms_provider_breaker(text,text,timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.service_get_sms_line_type_cache(text,text) from public, anon, authenticated;
revoke all on function public.service_put_sms_line_type_cache(text,text,text,timestamptz,integer) from public, anon, authenticated;
revoke all on function public.service_reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.service_release_sms_spend(uuid,text) from public, anon, authenticated;
revoke all on function public.service_finalize_sms_spend(uuid,text) from public, anon, authenticated;
revoke all on function public.service_record_sms_inbound_control_event(text,text,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.service_activate_sms_provider_breaker(text,text,timestamptz) from public, anon, authenticated;

grant execute on function public.service_get_sms_line_type_cache(text,text) to service_role;
grant execute on function public.service_put_sms_line_type_cache(text,text,text,timestamptz,integer) to service_role;
grant execute on function public.service_reserve_sms_spend(uuid,integer,integer,text,text,text,uuid,text) to service_role;
grant execute on function public.service_release_sms_spend(uuid,text) to service_role;
grant execute on function public.service_finalize_sms_spend(uuid,text) to service_role;
grant execute on function public.service_record_sms_inbound_control_event(text,text,timestamptz,text,text) to service_role;
grant execute on function public.service_activate_sms_provider_breaker(text,text,timestamptz) to service_role;

commit;
