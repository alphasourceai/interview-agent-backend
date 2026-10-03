-- Run against a disposable PostgreSQL database after the base payroll migration
-- and the Mercury migration. Synthetic IDs only; the transaction rolls back.
begin;
insert into public.sales_reps(user_id, email, display_name, active) values
  ('11111111-1111-4111-8111-111111111111', 'synthetic-rep@example.invalid', 'Synthetic Rep', true);
insert into public.sales_commission_receipts
  (id, purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
   payment_success_at, funds_received_at, qualification_closed_at, first_term_start_at,
   first_term_end_at, gross_membership_cents, statement_week_start, evidence_reference, reviewed_by_user_id)
values
  ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
   '11111111-1111-4111-8111-111111111111', 'stripe', 'pi_synthetic_mercury_001', 'monthly',
   '2026-07-07T18:00:00Z', '2026-07-08T18:00:00Z', '2026-07-07T19:00:00Z',
   '2026-07-01T00:00:00Z', '2027-07-01T00:00:00Z', 59900, '2026-07-06',
   'synthetic receipt', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into public.sales_commission_statement_locks
  (rep_user_id, week_start, snapshot, snapshot_sha256, locked_by_user_id)
values ('11111111-1111-4111-8111-111111111111', '2026-07-06', '{}'::jsonb,
        repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

set local role service_role;
do $$
declare
  first_import public.sales_commission_bank_transactions;
  replay public.sales_commission_bank_transactions;
  second_import public.sales_commission_bank_transactions;
  observed bigint;
begin
  first_import := public.import_sales_commission_bank_transaction(
    repeat('a', 64), '123456789012345', '2026-07-14', '2026-07-14T18:00:00Z',
    29950, '11111111-1111-4111-8111-111111111111', 'Synthetic Rep',
    'Admin verified synthetic ACH and exact commission allocation',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"receipt_id":"22222222-2222-4222-8222-222222222222","amount_cents":29950}]'::jsonb);
  replay := public.import_sales_commission_bank_transaction(
    repeat('a', 64), '123456789012345', '2026-07-14', '2026-07-14T18:00:00Z',
    29950, '11111111-1111-4111-8111-111111111111', 'Synthetic Rep',
    'Admin verified synthetic ACH and exact commission allocation',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"receipt_id":"22222222-2222-4222-8222-222222222222","amount_cents":29950}]'::jsonb);
  if replay.id <> first_import.id then raise exception 'replay_created_new_import'; end if;
  select count(*) into observed from public.sales_commission_payouts;
  if observed <> 1 then raise exception 'replay_created_duplicate_payout'; end if;
  begin
    perform public.import_sales_commission_bank_transaction(
      repeat('a', 64), '123456789012345', '2026-07-14', '2026-07-14T18:00:00Z',
      29951, '11111111-1111-4111-8111-111111111111', 'Synthetic Rep',
      'Admin verified synthetic ACH and exact commission allocation',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"receipt_id":"22222222-2222-4222-8222-222222222222","amount_cents":29951}]'::jsonb);
    raise exception 'changed_amount_was_accepted';
  exception when raise_exception then
    if sqlerrm <> 'bank_import_collision' then raise; end if;
  end;
  perform public.reverse_sales_commission_bank_transaction(
    first_import.id, '2026-07-17T18:00:00Z', 'synthetic bank reversal',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  select public.sales_commission_effective_paid('22222222-2222-4222-8222-222222222222') into observed;
  if observed <> 0 then raise exception 'reversal_did_not_restore_outstanding'; end if;
  second_import := public.import_sales_commission_bank_transaction(
    repeat('a', 64), '123456789012345', '2026-08-10', '2026-08-10T18:00:00Z',
    29950, '11111111-1111-4111-8111-111111111111', 'Synthetic Rep',
    'Admin verified synthetic ACH and exact commission allocation',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"receipt_id":"22222222-2222-4222-8222-222222222222","amount_cents":29950}]'::jsonb);
  if second_import.id = first_import.id then raise exception 'later_trace_reuse_collided'; end if;
  select public.sales_commission_effective_paid('22222222-2222-4222-8222-222222222222') into observed;
  if observed <> 29950 then raise exception 'new_payout_after_reversal_not_counted'; end if;
end;
$$;
rollback;
