alter table public.membership_agreements
  add column if not exists is_current boolean not null default false,
  add column if not exists superseded_at timestamptz null,
  add column if not exists superseded_by_agreement_id uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'membership_agreements_superseded_by_fkey'
      and conrelid = 'public.membership_agreements'::regclass
  ) then
    alter table public.membership_agreements
      add constraint membership_agreements_superseded_by_fkey
      foreign key (superseded_by_agreement_id)
      references public.membership_agreements(id)
      on delete set null;
  end if;
end
$$;

alter table public.membership_agreements
  drop constraint if exists membership_agreements_status_check;

alter table public.membership_agreements
  add constraint membership_agreements_status_check
  check (status in ('draft', 'sent', 'signed', 'superseded'));

with ranked as (
  select
    id,
    client_id,
    row_number() over (
      partition by client_id
      order by signed_at desc nulls last, created_at desc nulls last, id desc
    ) as rn
  from public.membership_agreements
  where client_id is not null
    and status in ('signed', 'superseded')
),
latest as (
  select
    r.client_id,
    r.id as current_agreement_id
  from ranked r
  where r.rn = 1
)
update public.membership_agreements ma
set
  is_current = (ma.id = l.current_agreement_id),
  status = case
    when ma.id = l.current_agreement_id then 'signed'
    when ma.status in ('signed', 'superseded') then 'superseded'
    else ma.status
  end,
  superseded_at = case
    when ma.id = l.current_agreement_id then null
    when ma.status in ('signed', 'superseded') then coalesce(curr.signed_at, curr.created_at, ma.signed_at, ma.created_at)
    else null
  end,
  superseded_by_agreement_id = case
    when ma.id = l.current_agreement_id then null
    when ma.status in ('signed', 'superseded') then l.current_agreement_id
    else null
  end
from latest l
join public.membership_agreements curr
  on curr.id = l.current_agreement_id
where ma.client_id = l.client_id;

update public.membership_agreements
set
  is_current = false,
  superseded_at = null,
  superseded_by_agreement_id = null
where status in ('draft', 'sent');

create unique index if not exists membership_agreements_one_current_per_client_idx
  on public.membership_agreements (client_id)
  where is_current = true and client_id is not null;

create index if not exists membership_agreements_client_current_signed_idx
  on public.membership_agreements (client_id, is_current, signed_at desc, created_at desc);

create or replace function public.complete_membership_agreement_signing(
  p_agreement_id uuid,
  p_signed_at timestamptz,
  p_opened_at timestamptz,
  p_signer_typed_name text,
  p_signature_image_path text,
  p_signature_sha256 text,
  p_signer_ip text,
  p_signer_user_agent text,
  p_executed_pdf_path text,
  p_template_snapshot jsonb
)
returns table (
  id uuid,
  client_id uuid,
  status text,
  signed_at timestamptz,
  signer_typed_name text,
  client_legal_name text,
  primary_admin_name text,
  admin_email text,
  executed_pdf_path text,
  is_current boolean
)
language plpgsql
as $$
declare
  v_client_id uuid;
begin
  select ma.client_id
    into v_client_id
  from public.membership_agreements ma
  where ma.id = p_agreement_id
    and ma.status = 'sent'
  for update;

  if not found then
    return;
  end if;

  if v_client_id is not null then
    update public.membership_agreements ma
    set
      is_current = false,
      status = case when ma.status = 'signed' then 'superseded' else ma.status end,
      superseded_at = p_signed_at,
      superseded_by_agreement_id = p_agreement_id,
      updated_at = p_signed_at
    where ma.client_id = v_client_id
      and ma.is_current = true
      and ma.id <> p_agreement_id;
  end if;

  return query
  update public.membership_agreements ma
  set
    status = 'signed',
    opened_at = coalesce(ma.opened_at, p_opened_at),
    signed_at = p_signed_at,
    signer_typed_name = p_signer_typed_name,
    signer_accepted = true,
    signature_image_path = p_signature_image_path,
    signature_sha256 = p_signature_sha256,
    signer_ip = p_signer_ip,
    signer_user_agent = p_signer_user_agent,
    executed_pdf_path = p_executed_pdf_path,
    template_snapshot = p_template_snapshot,
    updated_at = p_signed_at,
    is_current = true,
    superseded_at = null,
    superseded_by_agreement_id = null
  where ma.id = p_agreement_id
    and ma.status = 'sent'
  returning
    ma.id,
    ma.client_id,
    ma.status,
    ma.signed_at,
    ma.signer_typed_name,
    ma.client_legal_name,
    ma.primary_admin_name,
    ma.admin_email,
    ma.executed_pdf_path,
    ma.is_current;
end;
$$;
