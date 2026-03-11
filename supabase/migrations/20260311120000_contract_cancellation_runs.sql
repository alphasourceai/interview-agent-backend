create extension if not exists pgcrypto;

create table if not exists public.contract_cancellation_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  client_name text null,
  triggered_by_user_id uuid null,
  triggered_by_email text null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  status text not null default 'started',
  final_invoice_amount numeric null,
  stripe_invoice_id text null,
  stripe_subscription_id text null,
  note text null,
  request_id text null,
  error text null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);
