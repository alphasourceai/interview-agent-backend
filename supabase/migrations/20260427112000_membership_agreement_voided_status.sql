alter table public.membership_agreements
  add column if not exists voided_at timestamptz null,
  add column if not exists voided_by_email text null,
  add column if not exists void_reason text null;

alter table public.membership_agreements
  drop constraint if exists membership_agreements_status_check;

alter table public.membership_agreements
  add constraint membership_agreements_status_check
  check (status in ('draft', 'sent', 'signed', 'superseded', 'voided'));
