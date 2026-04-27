alter table public.membership_agreements
  add column if not exists replaces_stripe_subscription_id text null,
  add column if not exists replaced_stripe_subscription_canceled_at timestamptz null,
  add column if not exists replacement_error text null,
  add column if not exists replacement_policy text null;

create index if not exists membership_agreements_replaces_stripe_subscription_id_idx
  on public.membership_agreements (replaces_stripe_subscription_id);
