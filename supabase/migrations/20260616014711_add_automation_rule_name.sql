alter table public.automation_rules
  add column if not exists name text null;

update public.automation_rules
set name = 'Automation rule'
where name is null
   or length(btrim(name)) = 0;

alter table public.automation_rules
  alter column name set default 'Automation rule',
  alter column name set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_rules'::regclass
      and conname = 'automation_rules_name_nonblank_check'
  ) then
    alter table public.automation_rules
      add constraint automation_rules_name_nonblank_check
      check (length(btrim(name)) > 0);
  end if;
end
$$;
