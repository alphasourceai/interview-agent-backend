begin;

create unique index if not exists otp_challenges_provider_event_uidx
  on private_auth.otp_challenges (provider, last_provider_event_id)
  where last_provider_event_id is not null;

create or replace function private_auth.record_otp_sms_delivery_event(
  p_provider text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_delivery_status text
)
returns table(
  challenge_id uuid,
  provider_delivery_status text,
  last_provider_event_id text,
  last_provider_event_at timestamptz,
  applied boolean,
  replayed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_challenge private_auth.otp_challenges%rowtype;
  v_apply boolean := false;
  v_replay boolean := false;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(p_provider, '') !~ '^[a-z0-9_-]{1,40}$' then
    raise exception using errcode = '22023', message = 'invalid provider';
  end if;
  if p_provider_message_id is null
     or char_length(p_provider_message_id) not between 1 and 255
     or btrim(p_provider_message_id) = ''
     or p_provider_message_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid provider message id';
  end if;
  if p_provider_event_id is null
     or char_length(p_provider_event_id) not between 1 and 255
     or btrim(p_provider_event_id) = ''
     or p_provider_event_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid provider event id';
  end if;
  if p_provider_event_at is null then
    raise exception using errcode = '22023', message = 'provider event timestamp is required';
  end if;
  if p_delivery_status not in ('queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid delivery status';
  end if;

  select c.* into v_challenge
  from private_auth.otp_challenges c
  where c.provider = p_provider
    and c.provider_message_id = p_provider_message_id
  for update;

  if not found then
    return;
  end if;
  if v_challenge.channel <> 'sms' then
    raise exception using errcode = '22023', message = 'SMS challenge required';
  end if;

  if v_challenge.last_provider_event_id = p_provider_event_id then
    v_replay := true;
  elsif v_challenge.last_provider_event_at is not null
        and p_provider_event_at <= v_challenge.last_provider_event_at then
    v_apply := false;
  elsif v_challenge.provider_delivery_status is null then
    v_apply := true;
  elsif v_challenge.provider_delivery_status = 'queued' then
    v_apply := true;
  elsif v_challenge.provider_delivery_status = 'sent'
        and p_delivery_status in ('sent', 'delivered', 'failed', 'undelivered') then
    v_apply := true;
  elsif v_challenge.provider_delivery_status = p_delivery_status then
    v_apply := true;
  end if;

  if v_apply then
    begin
      update private_auth.otp_challenges c
      set provider_delivery_status = p_delivery_status,
          sent_at = case
            when p_delivery_status in ('sent', 'delivered') then coalesce(c.sent_at, p_provider_event_at)
            else c.sent_at
          end,
          delivered_at = case
            when p_delivery_status = 'delivered' then coalesce(c.delivered_at, p_provider_event_at)
            else c.delivered_at
          end,
          failed_at = case
            when p_delivery_status in ('failed', 'undelivered', 'rejected') then coalesce(c.failed_at, p_provider_event_at)
            else c.failed_at
          end,
          last_provider_event_id = p_provider_event_id,
          last_provider_event_at = p_provider_event_at,
          updated_at = v_now
      where c.challenge_id = v_challenge.challenge_id;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'provider event already bound';
    end;
  end if;

  return query
  select c.challenge_id, c.provider_delivery_status,
         c.last_provider_event_id, c.last_provider_event_at,
         v_apply, v_replay
  from private_auth.otp_challenges c
  where c.challenge_id = v_challenge.challenge_id;
end
$function$;

create or replace function public.service_record_otp_sms_delivery_event(
  p_provider text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_provider_event_at timestamptz,
  p_delivery_status text
)
returns table(
  challenge_id uuid,
  provider_delivery_status text,
  last_provider_event_id text,
  last_provider_event_at timestamptz,
  applied boolean,
  replayed boolean
)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from private_auth.record_otp_sms_delivery_event(
    p_provider, p_provider_message_id, p_provider_event_id,
    p_provider_event_at, p_delivery_status
  )
$function$;

comment on function public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text) is
  'Service-role-only provider-neutral SMS delivery callback telemetry. It cannot alter OTP authentication authority.';

alter function private_auth.record_otp_sms_delivery_event(text,text,text,timestamptz,text) owner to postgres;
alter function public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text) owner to postgres;

revoke all on function private_auth.record_otp_sms_delivery_event(text,text,text,timestamptz,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text)
  to service_role;

commit;
