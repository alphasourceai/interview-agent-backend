create extension if not exists pgcrypto;

alter table public.roles
  add column if not exists tavus_document_id text null;

create table if not exists public.role_jd_replacements (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  actor_user_id uuid null,
  actor_type text null,
  reason text null,
  status text not null default 'completed',
  old_job_description_url text null,
  new_job_description_url text null,
  old_job_description_text text null,
  new_job_description_text text null,
  old_description text null,
  new_description text null,
  old_kb_document_id text null,
  new_kb_document_id text null,
  old_tavus_document_id text null,
  new_tavus_document_id text null,
  old_tavus_prompt text null,
  new_tavus_prompt text null,
  old_rubric jsonb null,
  new_rubric jsonb null,
  old_rubric_questions jsonb null,
  new_rubric_questions jsonb null,
  error_metadata jsonb null,
  created_at timestamptz not null default now(),
  constraint role_jd_replacements_status_check
    check (status in ('processing', 'completed', 'failed')),
  constraint role_jd_replacements_error_metadata_object_check
    check (error_metadata is null or jsonb_typeof(error_metadata) = 'object')
);

create index if not exists role_jd_replacements_role_id_idx
  on public.role_jd_replacements (role_id);

create index if not exists role_jd_replacements_client_id_idx
  on public.role_jd_replacements (client_id);

create index if not exists role_jd_replacements_created_at_idx
  on public.role_jd_replacements (created_at desc);

alter table public.role_jd_replacements enable row level security;

revoke all on table public.role_jd_replacements from public;
revoke all on table public.role_jd_replacements from anon;
revoke all on table public.role_jd_replacements from authenticated;
grant select, insert, update on table public.role_jd_replacements to service_role;

comment on table public.role_jd_replacements is
  'Server-managed history for staged job-description replacement attempts.';

create or replace function public.complete_role_jd_replacement(
  p_replacement_id uuid,
  p_role_id uuid,
  p_client_id uuid,
  p_new_job_description_url text,
  p_new_job_description_text text,
  p_new_description text,
  p_new_rubric jsonb,
  p_new_rubric_questions jsonb,
  p_new_kb_document_id text,
  p_new_tavus_document_id text,
  p_new_tavus_prompt text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_role public.roles%rowtype;
  v_result jsonb;
begin
  select *
    into v_role
    from public.roles
   where id = p_role_id
     and client_id = p_client_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROLE_NOT_FOUND';
  end if;

  if coalesce(v_role.status, 'active') <> 'active' then
    raise exception using errcode = 'P0001', message = 'ROLE_NOT_ACTIVE';
  end if;

  if exists (select 1 from public.candidates where role_id = p_role_id)
    or exists (select 1 from public.interviews where role_id = p_role_id)
    or exists (select 1 from public.reports where role_id = p_role_id)
    or exists (select 1 from public.otp_tokens where role_id = p_role_id)
    or exists (select 1 from public.accommodation_requests where role_id = p_role_id)
    or exists (
      select 1 from public.automation_rules
       where role_id = p_role_id and archived_at is null
    )
    or exists (select 1 from public.automation_evaluations where role_id = p_role_id)
    or exists (select 1 from public.automation_actions where role_id = p_role_id)
    or exists (
      select 1
        from public.automation_action_events event
        join public.automation_actions action on action.id = event.action_id
       where action.role_id = p_role_id
    )
    or exists (
      select 1
        from public.automation_action_approval_tokens token
        join public.automation_actions action on action.id = token.action_id
       where action.role_id = p_role_id
    )
    or exists (select 1 from public.automation_digest_deliveries where role_id = p_role_id)
    or exists (
      select 1
        from public.automation_digest_approval_tokens token
        join public.automation_digest_deliveries delivery on delivery.id = token.delivery_id
       where delivery.role_id = p_role_id
    )
    or exists (select 1 from public.digest_logs where role_id = p_role_id)
  then
    raise exception using errcode = 'P0001', message = 'ROLE_ACTIVITY_EXISTS';
  end if;

  update public.roles
     set job_description_url = p_new_job_description_url,
         job_description_text = p_new_job_description_text,
         description = p_new_description,
         rubric = p_new_rubric,
         rubric_questions = p_new_rubric_questions,
         kb_document_id = p_new_kb_document_id,
         tavus_document_id = p_new_tavus_document_id,
         tavus_prompt = p_new_tavus_prompt
   where id = p_role_id
     and client_id = p_client_id;

  update public.role_jd_replacements
     set status = 'completed',
         new_job_description_url = p_new_job_description_url,
         new_job_description_text = p_new_job_description_text,
         new_description = p_new_description,
         new_rubric = p_new_rubric,
         new_rubric_questions = p_new_rubric_questions,
         new_kb_document_id = p_new_kb_document_id,
         new_tavus_document_id = p_new_tavus_document_id,
         new_tavus_prompt = p_new_tavus_prompt,
         error_metadata = null
   where id = p_replacement_id
     and role_id = p_role_id
     and client_id = p_client_id
     and status = 'processing';

  if not found then
    raise exception using errcode = 'P0002', message = 'REPLACEMENT_NOT_FOUND';
  end if;

  select to_jsonb(role_row)
    into v_result
    from public.roles role_row
   where role_row.id = p_role_id
     and role_row.client_id = p_client_id;

  return v_result;
end;
$$;

revoke all on function public.complete_role_jd_replacement(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text
) from public;
revoke all on function public.complete_role_jd_replacement(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text
) from anon;
revoke all on function public.complete_role_jd_replacement(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text
) from authenticated;
grant execute on function public.complete_role_jd_replacement(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text
) to service_role;
