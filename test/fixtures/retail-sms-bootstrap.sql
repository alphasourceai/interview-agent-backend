create table public.public_purchase_intents (
  id uuid primary key,
  status text not null,
  selected_plan_key text not null,
  selected_billing_cadence text not null,
  buyer_phone text,
  email_verified_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default statement_timestamp()
);

create table public.retail_signup_email_verifications (
  id uuid primary key,
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  updated_at timestamptz not null default statement_timestamp()
);

alter table public.public_purchase_intents owner to postgres;
alter table public.retail_signup_email_verifications owner to postgres;

insert into public.public_purchase_intents (
  id,
  status,
  selected_plan_key,
  selected_billing_cadence,
  buyer_phone,
  expires_at
) values (
  '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a184',
  'pending',
  'basic',
  'annual',
  '+1 (555) 555-0184',
  statement_timestamp() + interval '1 hour'
);

insert into public.retail_signup_email_verifications (
  id,
  purchase_intent_id
) values (
  '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a185',
  '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a184'
);
