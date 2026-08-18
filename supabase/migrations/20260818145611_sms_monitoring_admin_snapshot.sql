begin;

create or replace function private_auth.get_sms_monitoring_snapshot(
  p_since timestamptz,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_delivery jsonb;
  v_consent jsonb;
  v_suppression jsonb;
  v_spend jsonb := jsonb_build_object('available', false);
  v_line_type jsonb := jsonb_build_object('available', false);
  v_inbound jsonb := jsonb_build_object('available', false);
  v_breakers jsonb := jsonb_build_object('available', false);
  v_incidents jsonb;
begin
  if p_since is null
    or p_since < v_now - interval '90 days'
    or p_since > v_now
  then
    raise exception using errcode = '22023', message = 'invalid sms monitoring range';
  end if;

  select jsonb_build_object(
    'requested', count(*) filter (where c.send_requested_at is not null),
    'accepted', count(*) filter (where c.provider_accepted_at is not null),
    'sent', count(*) filter (where c.sent_at is not null or c.provider_delivery_status = 'sent'),
    'delivered', count(*) filter (where c.delivered_at is not null or c.provider_delivery_status = 'delivered'),
    'failed', count(*) filter (
      where c.failed_at is not null
        or c.provider_delivery_status in ('failed', 'undelivered', 'rejected')
    ),
    'pending', count(*) filter (
      where c.send_requested_at is not null
        and c.delivered_at is null
        and c.failed_at is null
        and coalesce(c.provider_delivery_status, '') not in ('delivered', 'failed', 'undelivered', 'rejected')
    ),
    'delivery_rate_pct', coalesce(round(
      100.0 * count(*) filter (where c.delivered_at is not null or c.provider_delivery_status = 'delivered')
      / nullif(count(*) filter (where c.provider_accepted_at is not null), 0),
      1
    ), 0),
    'by_status', coalesce((
      select jsonb_object_agg(status_key, status_count)
      from (
        select coalesce(nullif(c2.provider_delivery_status, ''), 'not_recorded') as status_key,
               count(*) as status_count
        from private_auth.otp_challenges c2
        where c2.channel = 'sms'
          and c2.created_at >= p_since
          and (p_client_id is null or c2.client_id = p_client_id)
        group by 1
      ) statuses
    ), '{}'::jsonb),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day_bucket::date,
        'requested', daily.requested,
        'delivered', daily.delivered,
        'failed', daily.failed
      ) order by day_bucket)
      from generate_series(
        date_trunc('day', p_since),
        date_trunc('day', v_now),
        interval '1 day'
      ) day_bucket
      cross join lateral (
        select
          count(*) filter (where c3.send_requested_at is not null) as requested,
          count(*) filter (where c3.delivered_at is not null or c3.provider_delivery_status = 'delivered') as delivered,
          count(*) filter (
            where c3.failed_at is not null
              or c3.provider_delivery_status in ('failed', 'undelivered', 'rejected')
          ) as failed
        from private_auth.otp_challenges c3
        where c3.channel = 'sms'
          and c3.created_at >= day_bucket
          and c3.created_at < day_bucket + interval '1 day'
          and (p_client_id is null or c3.client_id = p_client_id)
      ) daily
    ), '[]'::jsonb)
  ) into v_delivery
  from private_auth.otp_challenges c
  where c.channel = 'sms'
    and c.created_at >= p_since
    and (p_client_id is null or c.client_id = p_client_id);

  select jsonb_build_object(
    'selected', count(*) filter (where c.sms_selection_at is not null),
    'accepted_without_selection_evidence', count(*) filter (
      where c.provider_accepted_at is not null and c.sms_selection_at is null
    ),
    'version_counts', coalesce((
      select jsonb_agg(jsonb_build_object('version', version_key, 'count', version_count) order by version_key)
      from (
        select coalesce(nullif(c2.consent_copy_version, ''), 'not_recorded') as version_key,
               count(*) as version_count
        from private_auth.otp_challenges c2
        where c2.channel = 'sms'
          and c2.created_at >= p_since
          and c2.sms_selection_at is not null
          and (p_client_id is null or c2.client_id = p_client_id)
        group by 1
      ) versions
    ), '[]'::jsonb)
  ) into v_consent
  from private_auth.otp_challenges c
  where c.channel = 'sms'
    and c.created_at >= p_since
    and (p_client_id is null or c.client_id = p_client_id);

  select jsonb_build_object(
    'scope', 'platform',
    'active', count(*) filter (where s.released_at is null),
    'released', count(*) filter (where s.released_at is not null),
    'opted_out', count(*) filter (where s.released_at is null and s.status = 'opted_out'),
    'admin_blocked', count(*) filter (where s.released_at is null and s.status = 'admin_blocked'),
    'provider_blocked', count(*) filter (where s.released_at is null and s.status = 'provider_blocked'),
    'abuse_blocked', count(*) filter (where s.released_at is null and s.status = 'abuse_blocked')
  ) into v_suppression
  from private_auth.sms_destination_suppressions s;

  if to_regclass('private_auth.sms_spend_reservations') is not null then
    execute $sql$
      select jsonb_build_object(
        'available', true,
        'scope', case when $2 is null then 'platform' else 'client' end,
        'today_counted_cents', coalesce(sum(r.reserved_cents) filter (
          where r.period_day = (statement_timestamp() at time zone 'UTC')::date
            and r.released_at is null
        ), 0),
        'today_counted_attempts', count(*) filter (
          where r.period_day = (statement_timestamp() at time zone 'UTC')::date
            and r.released_at is null
        ),
        'released_in_range', count(*) filter (
          where r.created_at >= $1 and r.released_at is not null
        )
      )
      from private_auth.sms_spend_reservations r
      left join public.candidates c on c.id = r.candidate_id
      where ($2 is null or c.client_id = $2)
    $sql$ into v_spend using p_since, p_client_id;
  end if;

  if to_regclass('private_auth.sms_line_type_cache') is not null then
    execute $sql$
      select jsonb_build_object(
        'available', true,
        'scope', 'platform',
        'mobile', count(*) filter (where line_type = 'mobile' and expires_at > statement_timestamp()),
        'landline', count(*) filter (where line_type = 'landline' and expires_at > statement_timestamp()),
        'voip', count(*) filter (where line_type = 'voip' and expires_at > statement_timestamp()),
        'unknown', count(*) filter (where line_type = 'unknown' and expires_at > statement_timestamp()),
        'expired', count(*) filter (where expires_at <= statement_timestamp())
      )
      from private_auth.sms_line_type_cache
    $sql$ into v_line_type;
  end if;

  if to_regclass('private_auth.sms_inbound_control_events') is not null then
    execute $sql$
      select jsonb_build_object(
        'available', true,
        'scope', 'platform',
        'stop', count(*) filter (where action = 'stop'),
        'start', count(*) filter (where action = 'start'),
        'help', count(*) filter (where action = 'help')
      )
      from private_auth.sms_inbound_control_events
      where created_at >= $1
    $sql$ into v_inbound using p_since;
  end if;

  if to_regclass('private_auth.sms_provider_breakers') is not null then
    execute $sql$
      select jsonb_build_object(
        'available', true,
        'scope', 'platform',
        'active', count(*) filter (where active = true),
        'released', count(*) filter (where active = false)
      )
      from private_auth.sms_provider_breakers
    $sql$ into v_breakers;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'occurred_at', coalesce(c.failed_at, c.last_provider_event_at, c.send_requested_at, c.created_at),
    'provider', coalesce(c.provider, 'not_recorded'),
    'delivery_status', coalesce(c.provider_delivery_status, 'not_recorded'),
    'failure_category', coalesce(c.failure_category, 'not_recorded')
  ) order by coalesce(c.failed_at, c.last_provider_event_at, c.send_requested_at, c.created_at) desc), '[]'::jsonb)
  into v_incidents
  from (
    select *
    from private_auth.otp_challenges c2
    where c2.channel = 'sms'
      and c2.created_at >= p_since
      and (p_client_id is null or c2.client_id = p_client_id)
      and (
        c2.failed_at is not null
        or c2.failure_category is not null
        or c2.provider_delivery_status in ('failed', 'undelivered', 'rejected')
      )
    order by coalesce(c2.failed_at, c2.last_provider_event_at, c2.send_requested_at, c2.created_at) desc
    limit 50
  ) c;

  return jsonb_build_object(
    'generated_at', v_now,
    'range_start', p_since,
    'scope', case when p_client_id is null then 'platform' else 'client' end,
    'delivery', v_delivery,
    'consent', v_consent,
    'suppressions', v_suppression,
    'spend', v_spend,
    'line_type', v_line_type,
    'inbound', v_inbound,
    'provider_breakers', v_breakers,
    'incidents', v_incidents,
    'capabilities', jsonb_build_object(
      'spend_monitoring', to_regclass('private_auth.sms_spend_reservations') is not null,
      'line_type_monitoring', to_regclass('private_auth.sms_line_type_cache') is not null,
      'inbound_control_monitoring', to_regclass('private_auth.sms_inbound_control_events') is not null,
      'provider_breaker_monitoring', to_regclass('private_auth.sms_provider_breakers') is not null
    )
  );
end
$function$;

create or replace function public.service_get_sms_monitoring_snapshot(
  p_since timestamptz,
  p_client_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private_auth.get_sms_monitoring_snapshot(p_since, p_client_id)
$function$;

alter function private_auth.get_sms_monitoring_snapshot(timestamptz,uuid) owner to postgres;
alter function public.service_get_sms_monitoring_snapshot(timestamptz,uuid) owner to postgres;

revoke all on function private_auth.get_sms_monitoring_snapshot(timestamptz,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.service_get_sms_monitoring_snapshot(timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.service_get_sms_monitoring_snapshot(timestamptz,uuid)
  to service_role;

commit;
