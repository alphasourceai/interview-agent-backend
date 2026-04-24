alter table public.membership_agreements
  add column if not exists checkout_status text null,
  add column if not exists checkout_session_id text null,
  add column if not exists checkout_created_at timestamptz null,
  add column if not exists checkout_paid_at timestamptz null;

alter table public.membership_agreements
  drop constraint if exists membership_agreements_checkout_status_check;

alter table public.membership_agreements
  add constraint membership_agreements_checkout_status_check
  check (checkout_status is null or checkout_status in ('pending_payment', 'paid'));

create index if not exists membership_agreements_checkout_session_id_idx
  on public.membership_agreements (checkout_session_id);
