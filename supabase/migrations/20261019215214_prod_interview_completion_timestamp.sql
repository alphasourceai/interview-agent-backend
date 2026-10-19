-- Forward-only production completion field. Historical updated_at is NOT evidence.
begin;
set local lock_timeout='10s';
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='interviews' and column_name='completed_at')
 then raise exception 'prod_completion_column_already_exists';end if;
end $$;
alter table public.interviews add column completed_at timestamptz null;
create index interviews_client_id_completed_at_idx on public.interviews(client_id,completed_at);
-- Deliberately no historical backfill, customer/plan change, grants or RLS change.
commit;
