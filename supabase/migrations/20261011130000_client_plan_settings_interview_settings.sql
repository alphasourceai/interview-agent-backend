-- Per-client interview settings on client_plan_settings.
--
-- scored_question_count is new: how many scored questions an interview for this
-- client asks. Null means "use the plan default" (Essentials 5, Pro 6,
-- Enterprise 7). The upper bound is enforced in src/services/enterpriseSettings.js
-- from the rubric blueprints, not here, so it can follow them without a migration.
--
-- max_interview_minutes already exists in the hosted database (NOT NULL, no
-- default) and is not created or altered here; it only gains a comment, and only
-- where it exists. The code always writes it: the plan default for the row's
-- tier, or the length an Enterprise agreement set.
--
-- public.client_plan_settings is not created by any migration in this repository,
-- so this file can only alter it. Every statement is guarded: re-running it is a
-- no-op. No access change.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'scored_question_count'
  ) then
    alter table public.client_plan_settings
      add column scored_question_count integer null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'client_plan_settings_scored_question_count_check'
      and conrelid = 'public.client_plan_settings'::regclass
  ) then
    alter table public.client_plan_settings
      add constraint client_plan_settings_scored_question_count_check
      check (scored_question_count is null or scored_question_count > 0);
  end if;

  comment on column public.client_plan_settings.scored_question_count is
    'COUNT. Scored questions per interview for this client. Null means the plan default (Essentials 5, Pro 6, Enterprise 7). Set from an Enterprise agreement.';

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'max_interview_minutes'
  ) then
    comment on column public.client_plan_settings.max_interview_minutes is
      'MINUTES. Interview length for this client. Never null: it holds the plan default for the tier (Essentials 10, Pro 12, Enterprise 15) unless an Enterprise agreement set it, 5 to 59; the provider ends a call at 60 minutes.';
  end if;
end $$;
