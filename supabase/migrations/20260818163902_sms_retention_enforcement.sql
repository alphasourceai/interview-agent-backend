begin;

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists private_auth.sms_retention_runs (
  run_id bigint generated always as identity primary key,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  status text not null check (status = 'succeeded'),
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  check (completed_at >= started_at),
  check (jsonb_typeof(counts) = 'object' and octet_length(counts::text) <= 2048)
);

alter table private_auth.sms_retention_runs enable row level security;
alter table private_auth.sms_retention_runs owner to postgres;
revoke all on table private_auth.sms_retention_runs from public, anon, authenticated, service_role;

comment on table private_auth.sms_retention_runs is
  'Aggregate-only evidence of successful alphaScreen SMS retention enforcement. Contains no destination, candidate, message, event, or challenge identifiers.';

update private_auth.sms_line_type_cache c
set expires_at = c.checked_at + interval '30 days',
    updated_at = statement_timestamp()
where c.expires_at > c.checked_at + interval '30 days';

alter table private_auth.sms_line_type_cache
  drop constraint if exists sms_line_type_cache_max_ttl_check;
alter table private_auth.sms_line_type_cache
  add constraint sms_line_type_cache_max_ttl_check
  check (expires_at <= checked_at + interval '30 days');

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
    or p_ttl_seconds not between 3600 and 2592000
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

create or replace function private_auth.enforce_sms_retention(
  p_now timestamptz default statement_timestamp(),
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := statement_timestamp();
  v_consent integer := 0;
  v_delivery integer := 0;
  v_suppressions integer := 0;
  v_inbound integer := 0;
  v_line_type integer := 0;
  v_spend integer := 0;
  v_breakers integer := 0;
  v_run_history integer := 0;
  v_counts jsonb;
begin
  if p_now is null
    or p_now < statement_timestamp() - interval '1 day'
    or p_now > statement_timestamp() + interval '1 day'
  then
    raise exception using errcode = '22023', message = 'invalid sms retention timestamp';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('alphascreen-sms-retention', 0)
  ) then
    return jsonb_build_object('status', 'already_running', 'dry_run', p_dry_run);
  end if;

  if p_dry_run then
    select count(*) into v_consent
    from private_auth.otp_challenges c
    where c.channel = 'sms'
      and c.sms_selection_at is not null
      and greatest(c.sms_selection_at, c.created_at) < p_now - interval '4 years';

    select count(*) into v_delivery
    from private_auth.otp_challenges c
    where c.channel = 'sms'
      and (
        c.provider is not null or c.provider_message_id is not null
        or c.provider_delivery_status is not null or c.send_requested_at is not null
        or c.provider_accepted_at is not null or c.sent_at is not null
        or c.delivered_at is not null or c.failed_at is not null
        or c.failure_category is not null or c.last_provider_event_id is not null
        or c.last_provider_event_at is not null
      )
      and greatest(
        c.created_at,
        coalesce(c.send_requested_at, c.created_at),
        coalesce(c.provider_accepted_at, c.created_at),
        coalesce(c.sent_at, c.created_at),
        coalesce(c.delivered_at, c.created_at),
        coalesce(c.failed_at, c.created_at),
        coalesce(c.last_provider_event_at, c.created_at)
      ) < p_now - interval '13 months';

    select count(*) into v_suppressions
    from private_auth.sms_destination_suppressions s
    where s.released_at is not null
      and s.released_at < p_now - interval '4 years';

    select count(*) into v_inbound
    from private_auth.sms_inbound_control_events e
    where greatest(e.created_at, e.provider_event_at) < p_now - interval '4 years';

    select count(*) into v_line_type
    from private_auth.sms_line_type_cache c
    where c.expires_at <= p_now;

    select count(*) into v_spend
    from private_auth.sms_spend_reservations r
    where greatest(r.created_at, r.updated_at, coalesce(r.released_at, r.created_at))
      < p_now - interval '13 months';

    select count(*) into v_breakers
    from private_auth.sms_provider_breakers b
    where b.active = false
      and greatest(b.activated_at, b.updated_at, coalesce(b.released_at, b.activated_at))
        < p_now - interval '13 months';

    select count(*) into v_run_history
    from private_auth.sms_retention_runs r
    where r.completed_at < p_now - interval '13 months';
  else
    update private_auth.otp_challenges c
    set sms_selection_at = null,
        consent_copy_version = null,
        updated_at = statement_timestamp()
    where c.channel = 'sms'
      and c.sms_selection_at is not null
      and greatest(c.sms_selection_at, c.created_at) < p_now - interval '4 years';
    get diagnostics v_consent = row_count;

    update private_auth.otp_challenges c
    set provider = null,
        provider_message_id = null,
        provider_delivery_status = null,
        send_requested_at = null,
        provider_accepted_at = null,
        sent_at = null,
        delivered_at = null,
        failed_at = null,
        failure_category = null,
        last_provider_event_id = null,
        last_provider_event_at = null,
        updated_at = statement_timestamp()
    where c.channel = 'sms'
      and (
        c.provider is not null or c.provider_message_id is not null
        or c.provider_delivery_status is not null or c.send_requested_at is not null
        or c.provider_accepted_at is not null or c.sent_at is not null
        or c.delivered_at is not null or c.failed_at is not null
        or c.failure_category is not null or c.last_provider_event_id is not null
        or c.last_provider_event_at is not null
      )
      and greatest(
        c.created_at,
        coalesce(c.send_requested_at, c.created_at),
        coalesce(c.provider_accepted_at, c.created_at),
        coalesce(c.sent_at, c.created_at),
        coalesce(c.delivered_at, c.created_at),
        coalesce(c.failed_at, c.created_at),
        coalesce(c.last_provider_event_at, c.created_at)
      ) < p_now - interval '13 months';
    get diagnostics v_delivery = row_count;

    delete from private_auth.sms_destination_suppressions s
    where s.released_at is not null
      and s.released_at < p_now - interval '4 years';
    get diagnostics v_suppressions = row_count;

    delete from private_auth.sms_inbound_control_events e
    where greatest(e.created_at, e.provider_event_at) < p_now - interval '4 years';
    get diagnostics v_inbound = row_count;

    delete from private_auth.sms_line_type_cache c
    where c.expires_at <= p_now;
    get diagnostics v_line_type = row_count;

    delete from private_auth.sms_spend_reservations r
    where greatest(r.created_at, r.updated_at, coalesce(r.released_at, r.created_at))
      < p_now - interval '13 months';
    get diagnostics v_spend = row_count;

    delete from private_auth.sms_provider_breakers b
    where b.active = false
      and greatest(b.activated_at, b.updated_at, coalesce(b.released_at, b.activated_at))
        < p_now - interval '13 months';
    get diagnostics v_breakers = row_count;

    delete from private_auth.sms_retention_runs r
    where r.completed_at < p_now - interval '13 months';
    get diagnostics v_run_history = row_count;
  end if;

  v_counts := jsonb_build_object(
    'consent_evidence_cleared', v_consent,
    'delivery_telemetry_cleared', v_delivery,
    'released_suppressions_deleted', v_suppressions,
    'inbound_events_deleted', v_inbound,
    'expired_line_type_deleted', v_line_type,
    'spend_reservations_deleted', v_spend,
    'released_breakers_deleted', v_breakers,
    'retention_run_history_deleted', v_run_history
  );

  if not p_dry_run then
    insert into private_auth.sms_retention_runs (
      started_at, completed_at, status, counts
    ) values (
      v_started_at, statement_timestamp(), 'succeeded', v_counts
    );
  end if;

  return jsonb_build_object(
    'status', case when p_dry_run then 'dry_run' else 'succeeded' end,
    'dry_run', p_dry_run,
    'counts', v_counts
  );
end
$function$;

create or replace function private_auth.get_sms_retention_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'available', true,
    'scheduled', exists (
      select 1 from cron.job j
      where j.jobname = 'alphascreen-sms-retention-daily' and j.active = true
    ),
    'schedule_utc', coalesce((
      select j.schedule from cron.job j
      where j.jobname = 'alphascreen-sms-retention-daily'
      limit 1
    ), 'not_scheduled'),
    'last_completed_at', (
      select r.completed_at
      from private_auth.sms_retention_runs r
      where r.status = 'succeeded'
      order by r.completed_at desc
      limit 1
    ),
    'last_run_succeeded', coalesce((
      select r.status = 'succeeded'
        and r.completed_at >= statement_timestamp() - interval '36 hours'
        and coalesce((
          select d.status in ('succeeded', 'running')
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
          where j.jobname = 'alphascreen-sms-retention-daily'
          order by d.start_time desc
          limit 1
        ), true)
      from private_auth.sms_retention_runs r
      order by r.completed_at desc
      limit 1
    ), false),
    'last_scheduler_status', coalesce((
      select d.status
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      where j.jobname = 'alphascreen-sms-retention-daily'
      order by d.start_time desc
      limit 1
    ), 'not_recorded'),
    'last_counts', coalesce((
      select r.counts
      from private_auth.sms_retention_runs r
      where r.status = 'succeeded'
      order by r.completed_at desc
      limit 1
    ), '{}'::jsonb)
  )
$function$;

create or replace function public.service_get_sms_retention_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private_auth.get_sms_retention_snapshot()
$function$;

alter function private_auth.enforce_sms_retention(timestamptz,boolean) owner to postgres;
alter function private_auth.put_sms_line_type_cache(text,text,text,timestamptz,integer) owner to postgres;
alter function private_auth.get_sms_retention_snapshot() owner to postgres;
alter function public.service_get_sms_retention_snapshot() owner to postgres;

revoke all on function private_auth.enforce_sms_retention(timestamptz,boolean)
  from public, anon, authenticated, service_role;
revoke all on function private_auth.put_sms_line_type_cache(text,text,text,timestamptz,integer)
  from public, anon, authenticated, service_role;
revoke all on function private_auth.get_sms_retention_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.service_get_sms_retention_snapshot()
  from public, anon, authenticated;
grant execute on function public.service_get_sms_retention_snapshot()
  to service_role;

-- Supabase Cron documents named cron.schedule as an upsert: replaying the
-- migration replaces this exact named job instead of creating a duplicate.
select cron.schedule(
  'alphascreen-sms-retention-daily',
  '25 3 * * *',
  $cron$select private_auth.enforce_sms_retention(statement_timestamp(), false);$cron$
);

commit;
