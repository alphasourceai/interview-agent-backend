create extension if not exists pgcrypto;

create table if not exists public.role_interview_purchases (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  role_id uuid not null,
  quantity integer not null,
  status text not null default 'pending',
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,
  stripe_invoice_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint role_interview_purchases_quantity_check check (quantity > 0),
  constraint role_interview_purchases_status_check check (status in ('pending', 'paid', 'voided', 'refunded'))
);
