-- Additive accepted-pricing cadence compatibility; no old row/backfill/ACL change.
begin;
set local lock_timeout='10s';
do $guard$
declare d text;
begin
 select pg_get_constraintdef(oid) into d from pg_constraint where conrelid='public.public_purchase_intents'::regclass
  and conname='public_purchase_intents_billing_check' and contype='c';
 if d is distinct from 'CHECK ((selected_billing_cadence = ANY (ARRAY[''monthly''::text, ''annual''::text])))' then
  raise exception 'retail_intent_cadence_constraint_drift';end if;
 alter table public.public_purchase_intents drop constraint public_purchase_intents_billing_check;
 alter table public.public_purchase_intents add constraint public_purchase_intents_billing_check
  check(selected_billing_cadence=any(array['monthly'::text,'annual'::text,'prepaid'::text]));
end $guard$;
commit;
