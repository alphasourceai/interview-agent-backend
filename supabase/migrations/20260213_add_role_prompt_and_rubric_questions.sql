alter table public.roles add column if not exists tavus_prompt text;
alter table public.roles add column if not exists rubric_questions jsonb;
