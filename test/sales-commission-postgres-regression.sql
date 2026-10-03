-- Run against an isolated PostgreSQL database after the sales commission migration.
-- This transaction is rolled back so the fixture never becomes a ledger entry.
begin;
do $$
declare
  tested_intent uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tested_rep uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  reviewer uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  first_commission bigint;
  later_commission bigint;
  late_rejected boolean := false;
begin
  insert into public.sales_commission_receipts
    (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
     payment_success_at, funds_received_at, qualification_closed_at,
     first_term_start_at, first_term_end_at, gross_membership_cents,
     discount_cents, provider_fee_cents, statement_week_start,
     evidence_reference, reviewed_by_user_id)
  values
    (tested_intent, tested_rep, 'stripe', 'pi_pg_first_month', 'monthly',
     '2026-01-10T18:00:00Z', '2026-01-11T18:00:00Z', '2026-01-10T18:00:00Z',
     '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
     0, 897, '2026-01-12', 'first month provider receipt', reviewer)
  returning commission_cents into first_commission;

  insert into public.sales_commission_receipts
    (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
     payment_success_at, funds_received_at, qualification_closed_at,
     first_term_start_at, first_term_end_at, gross_membership_cents,
     discount_cents, provider_fee_cents, statement_week_start,
     evidence_reference, reviewed_by_user_id)
  values
    (tested_intent, tested_rep, 'stripe', 'pi_pg_later_month', 'monthly',
     '2026-03-10T18:00:00Z', '2026-03-11T18:00:00Z', '2026-01-10T18:00:00Z',
     '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
     1000, 897, '2026-03-16', 'later month provider receipt', reviewer)
  returning commission_cents into later_commission;

  if first_commission <> 14502 or later_commission <> 14002 then
    raise exception 'monthly commissions incorrect: %, %', first_commission, later_commission;
  end if;
  if (select count(*) from public.sales_commission_receipts where purchase_intent_id = tested_intent) <> 2 then
    raise exception 'expected two independent first-term monthly receipts';
  end if;

  begin
    insert into public.sales_commission_receipts
      (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
       payment_success_at, funds_received_at, qualification_closed_at,
       first_term_start_at, first_term_end_at, gross_membership_cents,
       discount_cents, provider_fee_cents, statement_week_start,
       evidence_reference, reviewed_by_user_id)
    values
      (tested_intent, tested_rep, 'stripe', 'pi_pg_renewal_month', 'monthly',
       '2027-01-01T07:00:00Z', '2027-01-02T07:00:00Z', '2026-01-10T18:00:00Z',
       '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
       0, 897, '2027-01-04', 'renewal must be excluded', reviewer);
  exception when check_violation then late_rejected := true;
  end;
  if not late_rejected then raise exception 'renewal payment was accepted'; end if;
end;
$$;
rollback;
