begin;

create or replace function private_auth.record_otp_sms_delivery_metadata(
  p_challenge_id uuid,
  p_event text,
  p_provider text,
  p_provider_message_id text default null,
  p_delivery_status text default null,
  p_failure_category text default null
)
returns table(
  challenge_id uuid,
  provider text,
  provider_message_id text,
  provider_delivery_status text,
  send_requested_at timestamptz,
  provider_accepted_at timestamptz,
  failed_at timestamptz,
  failure_category text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_challenge private_auth.otp_challenges%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_challenge_id is null then
    raise exception using errcode = '22023', message = 'challenge_id is required';
  end if;
  if coalesce(p_event, '') not in ('send_requested', 'provider_accepted', 'send_outcome') then
    raise exception using errcode = '22023', message = 'invalid delivery metadata event';
  end if;
  if coalesce(p_provider, '') !~ '^[a-z0-9_-]{1,40}$' then
    raise exception using errcode = '22023', message = 'invalid provider';
  end if;

  select c.* into v_challenge
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'challenge not found';
  end if;
  if v_challenge.channel <> 'sms' then
    raise exception using errcode = '22023', message = 'SMS challenge required';
  end if;
  if v_challenge.provider is not null and v_challenge.provider <> p_provider then
    raise exception using errcode = '23514', message = 'provider binding conflict';
  end if;

  if p_event = 'send_requested' then
    if p_provider_message_id is not null or p_delivery_status is not null or p_failure_category is not null then
      raise exception using errcode = '22023', message = 'send_requested accepts provider only';
    end if;

    update private_auth.otp_challenges c
    set provider = coalesce(c.provider, p_provider),
        send_requested_at = coalesce(c.send_requested_at, v_now),
        updated_at = v_now
    where c.challenge_id = p_challenge_id;

  elsif p_event = 'provider_accepted' then
    if p_provider_message_id is null
       or char_length(p_provider_message_id) not between 1 and 255
       or btrim(p_provider_message_id) = ''
       or p_provider_message_id ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'invalid provider message id';
    end if;
    if p_delivery_status not in ('queued', 'sent') or p_failure_category is not null then
      raise exception using errcode = '22023', message = 'invalid accepted delivery metadata';
    end if;
    if v_challenge.send_requested_at is null then
      raise exception using errcode = '55000', message = 'send request metadata required';
    end if;
    if v_challenge.provider_message_id is not null
       and v_challenge.provider_message_id <> p_provider_message_id then
      raise exception using errcode = '23514', message = 'provider message binding conflict';
    end if;
    if v_challenge.provider_delivery_status is not null
       and (v_challenge.provider_message_id <> p_provider_message_id
            or v_challenge.provider_delivery_status <> p_delivery_status
            or v_challenge.failure_category is not null) then
      raise exception using errcode = '23514', message = 'accepted metadata conflict';
    end if;

    begin
      update private_auth.otp_challenges c
      set provider = coalesce(c.provider, p_provider),
          provider_message_id = coalesce(c.provider_message_id, p_provider_message_id),
          provider_delivery_status = coalesce(c.provider_delivery_status, p_delivery_status),
          provider_accepted_at = coalesce(c.provider_accepted_at, v_now),
          updated_at = v_now
      where c.challenge_id = p_challenge_id;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'provider message already bound';
    end;

  else
    if p_provider_message_id is not null then
      raise exception using errcode = '22023', message = 'send outcome cannot bind a message id';
    end if;
    if p_failure_category not in (
      'invalid_destination', 'blocked_destination', 'provider_rejected',
      'transient_preacceptance', 'ambiguous_outcome', 'misconfigured'
    ) then
      raise exception using errcode = '22023', message = 'invalid failure category';
    end if;
    if (p_failure_category in ('invalid_destination', 'blocked_destination', 'provider_rejected')
        and p_delivery_status <> 'rejected')
       or (p_failure_category in ('transient_preacceptance', 'misconfigured')
           and p_delivery_status <> 'failed')
       or (p_failure_category = 'ambiguous_outcome' and p_delivery_status is not null) then
      raise exception using errcode = '22023', message = 'invalid outcome status';
    end if;
    if v_challenge.send_requested_at is null then
      raise exception using errcode = '55000', message = 'send request metadata required';
    end if;
    if v_challenge.provider_message_id is not null or v_challenge.provider_accepted_at is not null then
      raise exception using errcode = '23514', message = 'accepted provider binding is immutable';
    end if;
    if v_challenge.failure_category is not null
       and (v_challenge.failure_category <> p_failure_category
            or v_challenge.provider_delivery_status is distinct from p_delivery_status) then
      raise exception using errcode = '23514', message = 'send outcome conflict';
    end if;

    update private_auth.otp_challenges c
    set provider = coalesce(c.provider, p_provider),
        provider_delivery_status = coalesce(c.provider_delivery_status, p_delivery_status),
        failure_category = coalesce(c.failure_category, p_failure_category),
        failed_at = case
          when p_failure_category = 'ambiguous_outcome' then c.failed_at
          else coalesce(c.failed_at, v_now)
        end,
        updated_at = v_now
    where c.challenge_id = p_challenge_id;
  end if;

  return query
  select c.challenge_id, c.provider, c.provider_message_id,
         c.provider_delivery_status, c.send_requested_at,
         c.provider_accepted_at, c.failed_at, c.failure_category
  from private_auth.otp_challenges c
  where c.challenge_id = p_challenge_id;
end
$function$;

create or replace function public.service_record_otp_sms_delivery_metadata(
  p_challenge_id uuid,
  p_event text,
  p_provider text,
  p_provider_message_id text default null,
  p_delivery_status text default null,
  p_failure_category text default null
)
returns table(
  challenge_id uuid,
  provider text,
  provider_message_id text,
  provider_delivery_status text,
  send_requested_at timestamptz,
  provider_accepted_at timestamptz,
  failed_at timestamptz,
  failure_category text
)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.record_otp_sms_delivery_metadata(
    p_challenge_id, p_event, p_provider, p_provider_message_id,
    p_delivery_status, p_failure_category
  )
$function$;

comment on function public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text) is
  'Service-role-only provider-neutral SMS send telemetry boundary. It cannot alter OTP authentication authority.';

alter function private_auth.record_otp_sms_delivery_metadata(uuid,text,text,text,text,text) owner to postgres;
alter function public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text) owner to postgres;

revoke all on function private_auth.record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)
  to service_role;

commit;
