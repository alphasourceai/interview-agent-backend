-- Minimal existing production tables for isolated migration/view verification.
-- Never run this file against a hosted database.
create table public.clients (
  id uuid primary key, billing_status text, subscription_status text
);
create table public.membership_agreements (
  id uuid primary key, client_id uuid, status text, checkout_status text,
  signed_at timestamptz, checkout_paid_at timestamptz
);
create table public.public_purchase_intents (
  id uuid primary key, client_id uuid, agreement_id uuid,
  company_legal_name text, buyer_email text, selected_plan_key text,
  selected_billing_cadence text, created_by_user_id uuid,
  activated_at timestamptz, status text
);
