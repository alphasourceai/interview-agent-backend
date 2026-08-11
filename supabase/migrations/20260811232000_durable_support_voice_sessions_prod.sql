begin;

create schema if not exists private_support authorization postgres;
alter schema private_support owner to postgres;
revoke all on schema private_support from public, anon, authenticated, service_role;

create table if not exists private_support.support_voice_sessions (
  session_id text primary key,
  credential_digest bytea,
  user_fingerprint text not null,
  phase text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint support_voice_sessions_session_id_shape
    check (session_id ~ '^[A-Za-z0-9_-]{22}$'),
  constraint support_voice_sessions_credential_shape
    check (credential_digest is null or octet_length(credential_digest) = 32),
  constraint support_voice_sessions_user_fingerprint_shape
    check (user_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint support_voice_sessions_phase
    check (phase in ('pending', 'active', 'closed')),
  constraint support_voice_sessions_close_reason
    check (close_reason is null or close_reason in (
      'ended', 'idle_timeout', 'max_duration', 'shutdown', 'expired',
      'response_failed', 'protocol_error', 'support_voice_unavailable',
      'abandoned', 'client_disconnected', 'other'
    )),
  constraint support_voice_sessions_state
    check (
      (phase = 'pending' and credential_digest is not null and consumed_at is null and closed_at is null and close_reason is null)
      or
      (phase = 'active' and credential_digest is null and consumed_at is not null and closed_at is null and close_reason is null)
      or
      (phase = 'closed' and credential_digest is null and closed_at is not null and close_reason is not null)
    )
);

alter table private_support.support_voice_sessions owner to postgres;
alter table private_support.support_voice_sessions enable row level security;
revoke all on table private_support.support_voice_sessions from public, anon, authenticated, service_role;

create unique index if not exists support_voice_sessions_live_user_uidx
  on private_support.support_voice_sessions (user_fingerprint)
  where phase in ('pending', 'active');

create unique index if not exists support_voice_sessions_credential_uidx
  on private_support.support_voice_sessions (credential_digest)
  where credential_digest is not null;

create index if not exists support_voice_sessions_live_expiry_idx
  on private_support.support_voice_sessions (expires_at)
  where phase in ('pending', 'active');

create or replace function private_support.expire_support_voice_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update private_support.support_voice_sessions
     set phase = 'closed',
         credential_digest = null,
         closed_at = clock_timestamp(),
         close_reason = 'expired',
         updated_at = clock_timestamp()
   where phase in ('pending', 'active')
     and expires_at <= clock_timestamp();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function private_support.expire_support_voice_sessions() owner to postgres;
revoke all on function private_support.expire_support_voice_sessions() from public, anon, authenticated, service_role;

create or replace function private_support.reserve_support_voice_session(
  p_session_id text,
  p_credential_digest_hex text,
  p_user_fingerprint text
)
returns table(status text, session_id text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_live_count integer;
begin
  if p_session_id is null or p_session_id !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception using errcode = '22023', message = 'invalid session id';
  end if;
  if p_credential_digest_hex is null or p_credential_digest_hex !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid credential digest';
  end if;
  if p_user_fingerprint is null or p_user_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid user fingerprint';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private_support.support_voice_sessions:reserve', 0)
  );
  perform private_support.expire_support_voice_sessions();

  if exists (
    select 1
      from private_support.support_voice_sessions s
     where s.user_fingerprint = p_user_fingerprint
       and s.phase in ('pending', 'active')
  ) then
    return query select 'conflict'::text, null::text, null::timestamptz;
    return;
  end if;

  select count(*)::integer
    into v_live_count
    from private_support.support_voice_sessions s
   where s.phase in ('pending', 'active');
  if v_live_count >= 20 then
    return query select 'capacity'::text, null::text, null::timestamptz;
    return;
  end if;

  v_expires_at := v_now + interval '60 seconds';
  insert into private_support.support_voice_sessions (
    session_id, credential_digest, user_fingerprint, phase, expires_at,
    created_at, updated_at
  ) values (
    p_session_id, pg_catalog.decode(p_credential_digest_hex, 'hex'),
    p_user_fingerprint, 'pending', v_expires_at, v_now, v_now
  );

  return query select 'created'::text, p_session_id, v_expires_at;
end;
$$;

alter function private_support.reserve_support_voice_session(text, text, text) owner to postgres;
revoke all on function private_support.reserve_support_voice_session(text, text, text) from public, anon, authenticated, service_role;

create or replace function private_support.consume_support_voice_session(
  p_credential_digest_hex text
)
returns table(status text, session_id text, user_fingerprint text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private_support.support_voice_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_credential_digest_hex is null or p_credential_digest_hex !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid credential digest';
  end if;

  select *
    into v_row
    from private_support.support_voice_sessions s
   where s.credential_digest = pg_catalog.decode(p_credential_digest_hex, 'hex')
     and s.phase = 'pending'
   for update;

  if not found then
    return query select 'invalid'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if v_row.expires_at <= v_now then
    update private_support.support_voice_sessions
       set phase = 'closed', credential_digest = null, closed_at = v_now,
           close_reason = 'expired', updated_at = v_now
     where private_support.support_voice_sessions.session_id = v_row.session_id;
    return query select 'expired'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  v_expires_at := v_now + interval '600 seconds';
  update private_support.support_voice_sessions
     set phase = 'active', credential_digest = null, consumed_at = v_now,
         expires_at = v_expires_at, updated_at = v_now
   where private_support.support_voice_sessions.session_id = v_row.session_id;

  return query select 'consumed'::text, v_row.session_id, v_row.user_fingerprint, v_expires_at;
end;
$$;

alter function private_support.consume_support_voice_session(text) owner to postgres;
revoke all on function private_support.consume_support_voice_session(text) from public, anon, authenticated, service_role;

create or replace function private_support.close_support_voice_session(
  p_session_id text,
  p_reason text
)
returns table(status text, session_id text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private_support.support_voice_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_id is null or p_session_id !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception using errcode = '22023', message = 'invalid session id';
  end if;
  if p_reason is null or p_reason not in (
    'ended', 'idle_timeout', 'max_duration', 'shutdown', 'expired',
    'response_failed', 'protocol_error', 'support_voice_unavailable',
    'abandoned', 'client_disconnected', 'other'
  ) then
    raise exception using errcode = '22023', message = 'invalid close reason';
  end if;

  select *
    into v_row
    from private_support.support_voice_sessions s
   where s.session_id = p_session_id
   for update;

  if not found then
    return query select 'missing'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_row.phase <> 'closed' then
    update private_support.support_voice_sessions
       set phase = 'closed', credential_digest = null, closed_at = v_now,
           close_reason = p_reason, updated_at = v_now
     where private_support.support_voice_sessions.session_id = v_row.session_id;
  end if;

  return query select 'closed'::text, v_row.session_id, v_row.expires_at;
end;
$$;

alter function private_support.close_support_voice_session(text, text) owner to postgres;
revoke all on function private_support.close_support_voice_session(text, text) from public, anon, authenticated, service_role;

create or replace function private_support.close_pending_support_voice_sessions(
  p_user_fingerprint text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_fingerprint is null or p_user_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid user fingerprint';
  end if;
  if p_reason is null or p_reason not in ('abandoned', 'response_failed', 'shutdown', 'other') then
    raise exception using errcode = '22023', message = 'invalid pending close reason';
  end if;

  update private_support.support_voice_sessions
     set phase = 'closed', credential_digest = null, closed_at = v_now,
         close_reason = p_reason, updated_at = v_now
   where user_fingerprint = p_user_fingerprint
     and phase = 'pending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function private_support.close_pending_support_voice_sessions(text, text) owner to postgres;
revoke all on function private_support.close_pending_support_voice_sessions(text, text) from public, anon, authenticated, service_role;

create or replace function private_support.support_voice_session_health()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.to_regclass('private_support.support_voice_sessions') is not null;
$$;

alter function private_support.support_voice_session_health() owner to postgres;
revoke all on function private_support.support_voice_session_health() from public, anon, authenticated, service_role;

create or replace function public.service_reserve_support_voice_session(
  p_session_id text,
  p_credential_digest_hex text,
  p_user_fingerprint text
)
returns table(status text, session_id text, expires_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select * from private_support.reserve_support_voice_session(
    p_session_id, p_credential_digest_hex, p_user_fingerprint
  );
$$;

create or replace function public.service_consume_support_voice_session(
  p_credential_digest_hex text
)
returns table(status text, session_id text, user_fingerprint text, expires_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select * from private_support.consume_support_voice_session(p_credential_digest_hex);
$$;

create or replace function public.service_close_support_voice_session(
  p_session_id text,
  p_reason text
)
returns table(status text, session_id text, expires_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select * from private_support.close_support_voice_session(p_session_id, p_reason);
$$;

create or replace function public.service_close_pending_support_voice_sessions(
  p_user_fingerprint text,
  p_reason text
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private_support.close_pending_support_voice_sessions(p_user_fingerprint, p_reason);
$$;

create or replace function public.service_support_voice_session_health()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private_support.support_voice_session_health();
$$;

alter function public.service_reserve_support_voice_session(text, text, text) owner to postgres;
alter function public.service_consume_support_voice_session(text) owner to postgres;
alter function public.service_close_support_voice_session(text, text) owner to postgres;
alter function public.service_close_pending_support_voice_sessions(text, text) owner to postgres;
alter function public.service_support_voice_session_health() owner to postgres;

revoke all on function public.service_reserve_support_voice_session(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.service_consume_support_voice_session(text) from public, anon, authenticated, service_role;
revoke all on function public.service_close_support_voice_session(text, text) from public, anon, authenticated, service_role;
revoke all on function public.service_close_pending_support_voice_sessions(text, text) from public, anon, authenticated, service_role;
revoke all on function public.service_support_voice_session_health() from public, anon, authenticated, service_role;

grant execute on function public.service_reserve_support_voice_session(text, text, text) to service_role;
grant execute on function public.service_consume_support_voice_session(text) to service_role;
grant execute on function public.service_close_support_voice_session(text, text) to service_role;
grant execute on function public.service_close_pending_support_voice_sessions(text, text) to service_role;
grant execute on function public.service_support_voice_session_health() to service_role;

commit;
