create extension if not exists pgcrypto;

create table if not exists public.contract_processing_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  processed_ok boolean null,
  summary jsonb null,
  items jsonb null,
  error text null,
  request_id text null,
  triggered_by_user_id uuid null,
  triggered_by_email text null,
  created_at timestamptz not null default now()
);
