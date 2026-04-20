create extension if not exists pgcrypto;

create table if not exists public.membership_agreements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid null,
  status text not null default 'draft',
  client_legal_name text not null,
  dba_trade_name text null,
  primary_admin_name text not null,
  admin_email text not null,
  membership_tier text not null,
  initial_term_start date not null,
  initial_renewal_date date not null,
  billing_option text not null,
  auto_renew boolean not null default true,
  notice_deadline_days integer not null default 30,
  template_version text not null default 'membership_agreement_v2_phase1',
  template_snapshot jsonb not null,
  draft_pdf_path text not null,
  signer_token_hash text not null,
  signer_token_expires_at timestamptz not null,
  sent_at timestamptz null,
  created_by_user_id uuid null,
  created_by_email text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint membership_agreements_status_check check (status in ('draft', 'sent')),
  constraint membership_agreements_membership_tier_check check (membership_tier in ('basic', 'pro', 'enterprise')),
  constraint membership_agreements_billing_option_check check (billing_option in ('monthly', 'annual')),
  constraint membership_agreements_notice_deadline_days_check check (notice_deadline_days > 0)
);

create unique index if not exists membership_agreements_signer_token_hash_key
  on public.membership_agreements (signer_token_hash);

create index if not exists membership_agreements_client_id_idx
  on public.membership_agreements (client_id);

create index if not exists membership_agreements_sent_at_idx
  on public.membership_agreements (sent_at desc);
