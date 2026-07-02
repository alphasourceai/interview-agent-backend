create table if not exists public.public_purchase_intents (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',
  selected_plan_key text not null,
  selected_billing_cadence text not null,
  package_snapshot jsonb not null default '{}'::jsonb,
  company_legal_name text not null,
  company_dba text,
  buyer_first_name text not null,
  buyer_last_name text not null,
  buyer_email text not null,
  buyer_phone text,
  buyer_title text,
  source_path text,
  agreement_id uuid,
  stripe_checkout_session_id text,
  client_id uuid,
  expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint public_purchase_intents_status_check
    check (status in ('pending', 'agreement_pending', 'checkout_pending', 'completed', 'expired', 'canceled')),
  constraint public_purchase_intents_plan_check
    check (selected_plan_key in ('basic', 'pro')),
  constraint public_purchase_intents_billing_check
    check (selected_billing_cadence in ('monthly', 'annual')),
  constraint public_purchase_intents_company_legal_name_length
    check (char_length(company_legal_name) between 1 and 160),
  constraint public_purchase_intents_company_dba_length
    check (company_dba is null or char_length(company_dba) <= 160),
  constraint public_purchase_intents_buyer_first_name_length
    check (char_length(buyer_first_name) between 1 and 80),
  constraint public_purchase_intents_buyer_last_name_length
    check (char_length(buyer_last_name) between 1 and 80),
  constraint public_purchase_intents_buyer_email_length
    check (char_length(buyer_email) between 3 and 254),
  constraint public_purchase_intents_buyer_phone_length
    check (buyer_phone is null or char_length(buyer_phone) <= 40),
  constraint public_purchase_intents_buyer_title_length
    check (buyer_title is null or char_length(buyer_title) <= 120),
  constraint public_purchase_intents_source_path_length
    check (source_path is null or char_length(source_path) <= 300),
  constraint public_purchase_intents_stripe_checkout_session_id_length
    check (stripe_checkout_session_id is null or char_length(stripe_checkout_session_id) <= 255)
);

alter table public.public_purchase_intents
  add column if not exists status text not null default 'pending';
alter table public.public_purchase_intents
  add column if not exists selected_plan_key text not null default 'basic';
alter table public.public_purchase_intents
  add column if not exists selected_billing_cadence text not null default 'monthly';
alter table public.public_purchase_intents
  add column if not exists package_snapshot jsonb not null default '{}'::jsonb;
alter table public.public_purchase_intents
  add column if not exists company_legal_name text not null default '';
alter table public.public_purchase_intents
  add column if not exists company_dba text;
alter table public.public_purchase_intents
  add column if not exists buyer_first_name text not null default '';
alter table public.public_purchase_intents
  add column if not exists buyer_last_name text not null default '';
alter table public.public_purchase_intents
  add column if not exists buyer_email text not null default '';
alter table public.public_purchase_intents
  add column if not exists buyer_phone text;
alter table public.public_purchase_intents
  add column if not exists buyer_title text;
alter table public.public_purchase_intents
  add column if not exists source_path text;
alter table public.public_purchase_intents
  add column if not exists agreement_id uuid;
alter table public.public_purchase_intents
  add column if not exists stripe_checkout_session_id text;
alter table public.public_purchase_intents
  add column if not exists client_id uuid;
alter table public.public_purchase_intents
  add column if not exists expires_at timestamp with time zone;
alter table public.public_purchase_intents
  add column if not exists created_at timestamp with time zone not null default now();
alter table public.public_purchase_intents
  add column if not exists updated_at timestamp with time zone not null default now();

create index if not exists public_purchase_intents_active_lookup_idx
  on public.public_purchase_intents (
    lower(buyer_email),
    lower(company_legal_name),
    selected_plan_key,
    selected_billing_cadence,
    status,
    created_at desc
  );

create index if not exists public_purchase_intents_status_created_idx
  on public.public_purchase_intents (status, created_at desc);

alter table public.public_purchase_intents enable row level security;

revoke all on table public.public_purchase_intents from anon;
revoke all on table public.public_purchase_intents from authenticated;
