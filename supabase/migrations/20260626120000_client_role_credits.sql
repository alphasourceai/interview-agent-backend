alter table public.public_purchase_intents
  add column if not exists first_role_prepay_selected boolean not null default false,
  add column if not exists first_role_prepay_amount_cents integer null,
  add column if not exists first_role_normal_role_fee_cents integer null,
  add column if not exists first_role_prepay_discount_percent integer null,
  add column if not exists first_role_prepay_credit_type text null;

alter table public.public_purchase_intents
  drop constraint if exists public_purchase_intents_first_role_prepay_check;

alter table public.public_purchase_intents
  add constraint public_purchase_intents_first_role_prepay_check
  check (
    (
      first_role_prepay_selected = false
      and first_role_prepay_amount_cents is null
      and first_role_normal_role_fee_cents is null
      and first_role_prepay_discount_percent is null
      and first_role_prepay_credit_type is null
    )
    or
    (
      first_role_prepay_selected = true
      and first_role_prepay_amount_cents > 0
      and first_role_normal_role_fee_cents > 0
      and first_role_prepay_discount_percent > 0
      and first_role_prepay_credit_type = 'first_role_prepay'
    )
  );

create index if not exists public_purchase_intents_first_role_prepay_idx
  on public.public_purchase_intents (first_role_prepay_selected, created_at desc)
  where first_role_prepay_selected = true;

create table if not exists public.client_role_credits (
  id uuid primary key default gen_random_uuid(),
  billing_client_id uuid not null references public.clients(id) on delete restrict,
  source_client_id uuid null references public.clients(id) on delete set null,
  source_public_purchase_intent_id uuid null references public.public_purchase_intents(id) on delete restrict,
  source_membership_agreement_id uuid null references public.membership_agreements(id) on delete restrict,
  source_stripe_checkout_session_id text null,
  credit_type text not null default 'first_role_prepay',
  membership_key text not null,
  normal_role_fee_cents integer not null,
  discounted_credit_amount_cents integer not null,
  discount_percent integer not null default 10,
  status text not null default 'unused',
  used_at timestamptz null,
  used_by_role_id uuid null references public.roles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_role_credits_credit_type_check
    check (credit_type in ('first_role_prepay')),
  constraint client_role_credits_membership_key_check
    check (membership_key in ('basic', 'pro')),
  constraint client_role_credits_status_check
    check (status in ('unused', 'used', 'voided')),
  constraint client_role_credits_amount_check
    check (
      normal_role_fee_cents > 0
      and discounted_credit_amount_cents > 0
      and discount_percent > 0
    ),
  constraint client_role_credits_used_state_check
    check (
      (
        status = 'used'
        and used_at is not null
        and used_by_role_id is not null
      )
      or
      (
        status in ('unused', 'voided')
        and used_at is null
        and used_by_role_id is null
      )
    )
);

create unique index if not exists client_role_credits_source_public_purchase_intent_uidx
  on public.client_role_credits (source_public_purchase_intent_id)
  where source_public_purchase_intent_id is not null;

create unique index if not exists client_role_credits_source_stripe_checkout_session_uidx
  on public.client_role_credits (source_stripe_checkout_session_id)
  where source_stripe_checkout_session_id is not null;

create index if not exists client_role_credits_unused_lookup_idx
  on public.client_role_credits (billing_client_id, credit_type, status, created_at)
  where status = 'unused';

alter table public.client_role_credits enable row level security;

revoke all on table public.client_role_credits from anon;
revoke all on table public.client_role_credits from authenticated;
