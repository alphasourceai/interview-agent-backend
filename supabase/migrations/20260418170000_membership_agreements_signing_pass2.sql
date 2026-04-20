alter table public.membership_agreements
  add column if not exists opened_at timestamptz null,
  add column if not exists signed_at timestamptz null,
  add column if not exists signer_typed_name text null,
  add column if not exists signer_accepted boolean null,
  add column if not exists signature_image_path text null,
  add column if not exists signature_sha256 text null,
  add column if not exists signer_ip text null,
  add column if not exists signer_user_agent text null,
  add column if not exists executed_pdf_path text null;

alter table public.membership_agreements
  drop constraint if exists membership_agreements_status_check;

alter table public.membership_agreements
  add constraint membership_agreements_status_check
  check (status in ('draft', 'sent', 'signed'));

create index if not exists membership_agreements_client_status_signed_at_idx
  on public.membership_agreements (client_id, status, signed_at desc);
