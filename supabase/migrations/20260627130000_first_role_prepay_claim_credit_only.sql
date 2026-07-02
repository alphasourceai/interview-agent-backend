alter table public.client_role_credits
  drop constraint if exists client_role_credits_status_check;

alter table public.client_role_credits
  add constraint client_role_credits_status_check
  check (status in ('unused', 'claimed', 'used', 'voided'));

alter table public.client_role_credits
  drop constraint if exists client_role_credits_used_state_check;

alter table public.client_role_credits
  add constraint client_role_credits_used_state_check
  check (
    (
      status = 'used'
      and used_at is not null
      and used_by_role_id is not null
    )
    or
    (
      status in ('unused', 'claimed', 'voided')
      and used_at is null
      and used_by_role_id is null
    )
  );

create or replace function public.claim_first_role_prepay_credit(
  p_billing_client_id uuid,
  p_source_client_id uuid,
  p_claim_context text default 'role_checkout'
)
returns table (
  ok boolean,
  credit_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit_id uuid;
  v_claim_context text;
begin
  if p_billing_client_id is null or p_source_client_id is null then
    return query select false, null::uuid, 'client_required'::text;
    return;
  end if;

  v_claim_context := nullif(trim(coalesce(p_claim_context, '')), '');
  if v_claim_context is null then
    v_claim_context := 'role_checkout';
  end if;

  select crc.id
    into v_credit_id
    from public.client_role_credits as crc
   where crc.billing_client_id = p_billing_client_id
     and crc.credit_type = 'first_role_prepay'
     and crc.status = 'unused'
     and crc.used_at is null
     and crc.used_by_role_id is null
   order by crc.created_at asc, crc.id asc
   for update skip locked
   limit 1;

  if not found then
    return query select false, null::uuid, 'credit_not_available'::text;
    return;
  end if;

  update public.client_role_credits as crc
     set status = 'claimed',
         source_client_id = coalesce(crc.source_client_id, p_source_client_id),
         metadata = coalesce(crc.metadata, '{}'::jsonb) || jsonb_build_object(
           'claimed_by', v_claim_context,
           'claimed_client_id', p_source_client_id,
           'claimed_at', now()
         ),
         updated_at = now()
   where crc.id = v_credit_id
     and crc.status = 'unused'
     and crc.used_at is null
     and crc.used_by_role_id is null;

  if not found then
    raise exception 'First-role prepay credit claim race for %', v_credit_id;
  end if;

  return query select true, v_credit_id, 'claimed'::text;
end;
$$;
