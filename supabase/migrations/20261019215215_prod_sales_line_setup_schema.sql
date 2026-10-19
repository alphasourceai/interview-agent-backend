-- Add reusable admin line setup structure only. NEVER copy QA seeds or routing.
begin;
set local lock_timeout='10s';
lock table public.sales_phone_numbers,public.sales_phone_assignments in share row exclusive mode;
create temporary table prod_phone_before on commit drop as select id,to_jsonb(p) snapshot from public.sales_phone_numbers p;
create temporary table prod_assignment_before on commit drop as select id,to_jsonb(p) snapshot from public.sales_phone_assignments p;
alter table public.sales_phone_numbers
 add column if not exists xai_agent_id text,
 add column if not exists xai_phone_number_e164 text,
 add column if not exists ghl_location_id text,
 add column if not exists ghl_routing_workflow_id text,
 add column if not exists ghl_notification_workflow_id text,
 add column if not exists ghl_mobile_custom_value_id text,
 add column if not exists ghl_mobile_custom_value_name text,
 add column if not exists ghl_user_custom_value_id text,
 add column if not exists ghl_user_custom_value_name text,
 add column if not exists xai_setup_status text not null default 'pending' check(xai_setup_status in('pending','verified','failed')),
 add column if not exists ghl_setup_status text not null default 'pending' check(ghl_setup_status in('pending','verified','failed')),
 add column if not exists xai_verified_at timestamptz,
 add column if not exists xai_verification_reference text,
 add column if not exists handoff_token_rotated_at timestamptz;
-- No update of labels, tokens, agents, custom values, assignments or status.
CREATE OR REPLACE FUNCTION public.apply_sales_team_configuration_v2(p_member_id uuid, p_existing_assignment_id uuid, p_replace_team_member_id uuid, p_actor_user_id uuid, p_member jsonb, p_assignment jsonb, p_config jsonb, p_generated_prompt text, p_prompt_checksum text, p_replace_assignment boolean, p_expected_draft_updated_at timestamp with time zone, p_handoff_token_sha256 text)
 RETURNS TABLE(assignment_id uuid, voice_config_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := now();
  v_assignment public.sales_phone_assignments%rowtype;
  v_occupied_assignment public.sales_phone_assignments%rowtype;
  v_assignment_id uuid;
  v_config_id uuid;
  v_version integer;
  v_member_status text;
  v_draft_updated_at timestamptz;
  v_replaced_sales_rep_user_id uuid;
begin
  if coalesce((p_config->>'notify_slack')::boolean, false) is not true
    or coalesce((p_config->>'notify_email')::boolean, false) is not true then
    raise exception 'sales_notification_channels_required';
  end if;
  if p_handoff_token_sha256 is null or p_handoff_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_handoff_token_required';
  end if;

  select status into v_member_status
  from public.sales_team_members where id = p_member_id for update;
  if not found then raise exception 'sales_team_member_not_found'; end if;
  if v_member_status = 'inactive' then raise exception 'sales_team_member_inactive'; end if;

  select updated_at into v_draft_updated_at
  from public.sales_team_config_drafts where team_member_id = p_member_id for update;
  if not found or v_draft_updated_at is distinct from p_expected_draft_updated_at then
    raise exception 'sales_team_draft_stale';
  end if;

  select * into v_occupied_assignment
  from public.sales_phone_assignments
  where phone_number_id = (p_assignment->>'phone_number_id')::uuid
    and status = 'active'
  for update;

  if v_occupied_assignment.id is not null and v_occupied_assignment.team_member_id is distinct from p_member_id then
    if p_replace_team_member_id is null or p_replace_team_member_id is distinct from v_occupied_assignment.team_member_id then
      raise exception 'sales_phone_replacement_stale';
    end if;
    select sales_rep_user_id into v_replaced_sales_rep_user_id
    from public.sales_team_members
    where id = v_occupied_assignment.team_member_id
    for update;
    update public.sales_voice_configs
    set is_current = false,
        status = case when status = 'applied' then 'superseded' else status end
    where public.sales_voice_configs.assignment_id = v_occupied_assignment.id and is_current;
    update public.sales_phone_assignments
    set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_occupied_assignment.id;
    update public.sales_team_members
    set status = 'inactive', inactive_at = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_occupied_assignment.team_member_id;
    update public.sales_reps set active = false, updated_at = v_now where user_id = v_replaced_sales_rep_user_id;
    delete from public.sales_team_config_drafts where team_member_id = v_occupied_assignment.team_member_id;
    insert into public.sales_integration_sync_jobs (
      team_member_id, assignment_id, provider, operation, status,
      provider_reference, requested_by_user_id, completed_at
    ) values
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'sales_dashboard', 'deactivate', 'synced', p_member_id::text, p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'slack', 'deactivate', 'not_applicable', 'routing-replaced', p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'ghl', 'deactivate', 'synced', 'routing-replaced', p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'xai', 'deactivate', 'not_applicable', 'line-retained', p_actor_user_id, v_now);
    insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action, safe_metadata)
    values (v_occupied_assignment.team_member_id, v_occupied_assignment.id, p_actor_user_id, 'sales_team_member_replaced', jsonb_build_object('replacement_team_member_id', p_member_id));
  elsif p_replace_team_member_id is not null then
    raise exception 'sales_phone_replacement_stale';
  end if;

  if p_existing_assignment_id is not null then
    select * into v_assignment
    from public.sales_phone_assignments
    where id = p_existing_assignment_id and team_member_id = p_member_id
    for update;
  end if;

  if p_replace_assignment and v_assignment.id is not null then
    update public.sales_voice_configs
    set is_current = false,
        status = case when status = 'applied' then 'superseded' else status end
    where public.sales_voice_configs.assignment_id = v_assignment.id and is_current;
    update public.sales_phone_assignments
    set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_assignment.id;
    v_assignment.id := null;
  end if;

  update public.sales_team_members
  set sales_rep_user_id = nullif(p_member->>'sales_rep_user_id', '')::uuid,
      display_name = p_member->>'display_name',
      workspace_email = nullif(p_member->>'workspace_email', ''),
      mobile_phone_e164 = nullif(p_member->>'mobile_phone_e164', ''),
      ghl_user_id = nullif(p_member->>'ghl_user_id', ''),
      slack_user_id = nullif(p_member->>'slack_user_id', ''),
      status = 'active',
      active_from = coalesce(active_from, (v_now at time zone 'America/Denver')::date),
      inactive_at = null,
      updated_by_user_id = p_actor_user_id,
      updated_at = v_now
  where id = p_member_id;

  if v_assignment.id is null then
    insert into public.sales_phone_assignments (
      team_member_id, phone_number_id, xai_agent_id, xai_phone_number_e164,
      handoff_token_sha256, handoff_token_rotated_at, ghl_location_id,
      ghl_notification_workflow_id, ring_seconds, call_connect_required,
      transfer_enabled, backup_transfer_phone_e164, status, effective_from,
      created_by_user_id, updated_by_user_id
    ) values (
      p_member_id, (p_assignment->>'phone_number_id')::uuid,
      nullif(p_assignment->>'xai_agent_id', ''), nullif(p_assignment->>'xai_phone_number_e164', ''),
      p_handoff_token_sha256, v_now,
      nullif(p_assignment->>'ghl_location_id', ''), nullif(p_assignment->>'ghl_notification_workflow_id', ''),
      (p_assignment->>'ring_seconds')::integer, true,
      (p_assignment->>'transfer_enabled')::boolean, nullif(p_assignment->>'backup_transfer_phone_e164', ''),
      'active', v_now, p_actor_user_id, p_actor_user_id
    ) returning id into v_assignment_id;
  else
    update public.sales_phone_assignments
    set phone_number_id = (p_assignment->>'phone_number_id')::uuid,
        xai_agent_id = nullif(p_assignment->>'xai_agent_id', ''),
        xai_phone_number_e164 = nullif(p_assignment->>'xai_phone_number_e164', ''),
        handoff_token_sha256 = p_handoff_token_sha256,
        handoff_token_rotated_at = case
          when handoff_token_sha256 is distinct from p_handoff_token_sha256 then v_now
          else handoff_token_rotated_at
        end,
        ghl_location_id = nullif(p_assignment->>'ghl_location_id', ''),
        ghl_notification_workflow_id = nullif(p_assignment->>'ghl_notification_workflow_id', ''),
        ring_seconds = (p_assignment->>'ring_seconds')::integer,
        call_connect_required = true,
        transfer_enabled = (p_assignment->>'transfer_enabled')::boolean,
        backup_transfer_phone_e164 = nullif(p_assignment->>'backup_transfer_phone_e164', ''),
        status = 'active', effective_from = coalesce(effective_from, v_now), effective_to = null,
        updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_assignment.id
    returning id into v_assignment_id;
  end if;

  update public.sales_voice_configs
  set is_current = false,
      status = case when status = 'applied' then 'superseded' else status end
  where public.sales_voice_configs.assignment_id = v_assignment_id and is_current;
  select coalesce(max(version), 0) + 1 into v_version
  from public.sales_voice_configs where public.sales_voice_configs.assignment_id = v_assignment_id;
  insert into public.sales_voice_configs (
    assignment_id, version, is_current, status, voice_id, greeting_override,
    approved_context, timezone, business_hours, answer_approved_faqs,
    schedule_demos, notify_slack, notify_sms, notify_email, generated_prompt,
    prompt_checksum, created_by_user_id, applied_at
  ) values (
    v_assignment_id, v_version, true, 'applied', p_config->>'voice_id',
    nullif(p_config->>'greeting_override', ''), coalesce(p_config->>'approved_context', ''),
    p_config->>'timezone', p_config->'business_hours',
    (p_config->>'answer_approved_faqs')::boolean, (p_config->>'schedule_demos')::boolean,
    true, coalesce((p_config->>'notify_sms')::boolean, false), true, p_generated_prompt, p_prompt_checksum, p_actor_user_id, v_now
  ) returning id into v_config_id;

  update public.sales_reps
  set email = p_member->>'workspace_email', display_name = p_member->>'display_name',
      slack_user_id = nullif(p_member->>'slack_user_id', ''), active = true, updated_at = v_now
  where user_id = nullif(p_member->>'sales_rep_user_id', '')::uuid;
  if not found then raise exception 'sales_rep_not_found'; end if;

  insert into public.sales_integration_sync_jobs (
    team_member_id, assignment_id, voice_config_id, provider, operation, status,
    provider_reference, last_error_code, last_error_detail, requested_by_user_id, completed_at
  ) values
    (p_member_id, v_assignment_id, v_config_id, 'sales_dashboard', 'apply', 'synced', p_member->>'sales_rep_user_id', null, null, p_actor_user_id, v_now),
    (p_member_id, v_assignment_id, v_config_id, 'slack', 'apply', 'action_required', null, 'slack_member_verification_required', 'Verify the saved Slack member mapping.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'ghl', 'apply', 'action_required', null, 'ghl_routing_apply_required', 'Apply and verify the saved GHL routing.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'xai', 'apply', 'action_required', null, 'xai_agent_verification_required', 'Verify the reusable Grok Voice line.', p_actor_user_id, null);
  delete from public.sales_team_config_drafts where team_member_id = p_member_id;
  insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action, safe_metadata)
  values (p_member_id, v_assignment_id, p_actor_user_id, 'sales_team_configuration_applied', jsonb_build_object(
    'providers', jsonb_build_array('sales_dashboard', 'ghl', 'xai', 'slack'),
    'replaced_team_member_id', p_replace_team_member_id
  ));
  return query select v_assignment_id, v_config_id;
end;
$function$;
revoke all on function public.apply_sales_team_configuration_v2(p_member_id uuid, p_existing_assignment_id uuid, p_replace_team_member_id uuid, p_actor_user_id uuid, p_member jsonb, p_assignment jsonb, p_config jsonb, p_generated_prompt text, p_prompt_checksum text, p_replace_assignment boolean, p_expected_draft_updated_at timestamp with time zone, p_handoff_token_sha256 text) from public,anon,authenticated;
grant execute on function public.apply_sales_team_configuration_v2(p_member_id uuid, p_existing_assignment_id uuid, p_replace_team_member_id uuid, p_actor_user_id uuid, p_member jsonb, p_assignment jsonb, p_config jsonb, p_generated_prompt text, p_prompt_checksum text, p_replace_assignment boolean, p_expected_draft_updated_at timestamp with time zone, p_handoff_token_sha256 text) to service_role;
CREATE OR REPLACE FUNCTION public.enforce_active_sales_line_token()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_line_token_sha256 text;
begin
  if new.status <> 'active' then return new; end if;
  select handoff_token_sha256 into v_line_token_sha256
  from public.sales_phone_numbers
  where id = new.phone_number_id and active = true;
  if v_line_token_sha256 is null or new.handoff_token_sha256 is distinct from v_line_token_sha256 then
    raise exception 'sales_voice_line_token_stale';
  end if;
  return new;
end;
$function$;
revoke all on function public.enforce_active_sales_line_token() from public,anon,authenticated;
grant execute on function public.enforce_active_sales_line_token() to service_role;
CREATE OR REPLACE FUNCTION public.rotate_sales_voice_line_token(p_phone_number_id uuid, p_team_member_id uuid, p_actor_user_id uuid, p_handoff_token_sha256 text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_member_id uuid;
begin
  if p_handoff_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_line_token_invalid';
  end if;

  select team_member_id into v_member_id
  from public.sales_phone_assignments
  where phone_number_id = p_phone_number_id and status = 'active'
  for update;
  if v_member_id is not null and v_member_id is distinct from p_team_member_id then
    raise exception 'sales_phone_number_in_use';
  end if;

  update public.sales_phone_numbers
  set handoff_token_sha256 = p_handoff_token_sha256,
      handoff_token_rotated_at = now(),
      xai_setup_status = 'pending',
      xai_verified_at = null,
      xai_verification_reference = null,
      updated_at = now()
  where id = p_phone_number_id and active = true;
  if not found then raise exception 'sales_phone_number_not_found'; end if;

  update public.sales_phone_assignments
  set handoff_token_sha256 = p_handoff_token_sha256,
      handoff_token_rotated_at = now(),
      updated_by_user_id = p_actor_user_id,
      updated_at = now()
  where phone_number_id = p_phone_number_id and status = 'active';

  if v_member_id is null then
    select team_member_id into v_member_id
    from public.sales_phone_assignments
    where phone_number_id = p_phone_number_id
    order by created_at desc
    limit 1;
  end if;

  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action, safe_metadata)
  values (v_member_id, p_actor_user_id, 'sales_voice_line_token_rotated', jsonb_build_object('phone_number_id', p_phone_number_id));
  return p_phone_number_id;
end;
$function$;
revoke all on function public.rotate_sales_voice_line_token(p_phone_number_id uuid, p_team_member_id uuid, p_actor_user_id uuid, p_handoff_token_sha256 text) from public,anon,authenticated;
grant execute on function public.rotate_sales_voice_line_token(p_phone_number_id uuid, p_team_member_id uuid, p_actor_user_id uuid, p_handoff_token_sha256 text) to service_role;
CREATE OR REPLACE FUNCTION public.save_sales_voice_line_setup(p_phone_number_id uuid, p_actor_user_id uuid, p_setup jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_member_id uuid;
  v_current public.sales_phone_numbers%rowtype;
  v_xai_changed boolean;
  v_ghl_changed boolean;
begin
  select * into v_current from public.sales_phone_numbers where id = p_phone_number_id and active = true for update;
  if not found then raise exception 'sales_phone_number_not_found'; end if;
  v_xai_changed := v_current.xai_agent_id is distinct from nullif(p_setup->>'xai_agent_id', '')
    or v_current.xai_phone_number_e164 is distinct from nullif(p_setup->>'xai_phone_number_e164', '');
  v_ghl_changed := v_current.ghl_location_id is distinct from nullif(p_setup->>'ghl_location_id', '')
    or v_current.ghl_routing_workflow_id is distinct from nullif(p_setup->>'ghl_routing_workflow_id', '')
    or v_current.ghl_notification_workflow_id is distinct from nullif(p_setup->>'ghl_notification_workflow_id', '')
    or v_current.ghl_mobile_custom_value_id is distinct from nullif(p_setup->>'ghl_mobile_custom_value_id', '')
    or v_current.ghl_mobile_custom_value_name is distinct from nullif(p_setup->>'ghl_mobile_custom_value_name', '')
    or v_current.ghl_user_custom_value_id is distinct from nullif(p_setup->>'ghl_user_custom_value_id', '')
    or v_current.ghl_user_custom_value_name is distinct from nullif(p_setup->>'ghl_user_custom_value_name', '');

  if not v_xai_changed and p_setup->>'xai_setup_status' = 'verified' and (
    nullif(p_setup->>'xai_agent_id', '') is null
    or nullif(p_setup->>'xai_phone_number_e164', '') is null
    or v_current.handoff_token_rotated_at is null
    or nullif(p_setup->>'xai_verification_reference', '') is null
  ) then
    raise exception 'xai_line_setup_incomplete';
  end if;
  if not v_ghl_changed and p_setup->>'ghl_setup_status' = 'verified' and (
    nullif(p_setup->>'ghl_location_id', '') is null
    or nullif(p_setup->>'ghl_routing_workflow_id', '') is null
    or nullif(p_setup->>'ghl_notification_workflow_id', '') is null
    or nullif(p_setup->>'ghl_mobile_custom_value_id', '') is null
    or nullif(p_setup->>'ghl_mobile_custom_value_name', '') is null
    or nullif(p_setup->>'ghl_user_custom_value_id', '') is null
    or nullif(p_setup->>'ghl_user_custom_value_name', '') is null
  ) then
    raise exception 'ghl_line_setup_incomplete';
  end if;

  update public.sales_phone_numbers
  set xai_agent_id = nullif(p_setup->>'xai_agent_id', ''),
      xai_phone_number_e164 = nullif(p_setup->>'xai_phone_number_e164', ''),
      ghl_location_id = nullif(p_setup->>'ghl_location_id', ''),
      ghl_routing_workflow_id = nullif(p_setup->>'ghl_routing_workflow_id', ''),
      ghl_notification_workflow_id = nullif(p_setup->>'ghl_notification_workflow_id', ''),
      ghl_mobile_custom_value_id = nullif(p_setup->>'ghl_mobile_custom_value_id', ''),
      ghl_mobile_custom_value_name = nullif(p_setup->>'ghl_mobile_custom_value_name', ''),
      ghl_user_custom_value_id = nullif(p_setup->>'ghl_user_custom_value_id', ''),
      ghl_user_custom_value_name = nullif(p_setup->>'ghl_user_custom_value_name', ''),
      xai_setup_status = case when v_xai_changed then 'pending' else p_setup->>'xai_setup_status' end,
      ghl_setup_status = case when v_ghl_changed then 'pending' else p_setup->>'ghl_setup_status' end,
      xai_verified_at = case
        when v_xai_changed or p_setup->>'xai_setup_status' <> 'verified' then null
        when p_setup->>'xai_setup_status' = 'verified' then now()
        else xai_verified_at
      end,
      xai_verification_reference = case
        when v_xai_changed or p_setup->>'xai_setup_status' <> 'verified' then null
        else nullif(p_setup->>'xai_verification_reference', '')
      end,
      updated_at = now()
  where id = p_phone_number_id and active = true;

  select team_member_id into v_member_id
  from public.sales_phone_assignments
  where phone_number_id = p_phone_number_id
  order by case status when 'active' then 0 when 'draft' then 1 else 2 end, created_at desc
  limit 1;
  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action, safe_metadata)
  values (v_member_id, p_actor_user_id, 'sales_voice_line_setup_saved', jsonb_build_object(
    'phone_number_id', p_phone_number_id,
    'xai_setup_status', case when v_xai_changed then 'pending' else p_setup->>'xai_setup_status' end,
    'ghl_setup_status', case when v_ghl_changed then 'pending' else p_setup->>'ghl_setup_status' end
  ));
  return p_phone_number_id;
end;
$function$;
revoke all on function public.save_sales_voice_line_setup(p_phone_number_id uuid, p_actor_user_id uuid, p_setup jsonb) from public,anon,authenticated;
grant execute on function public.save_sales_voice_line_setup(p_phone_number_id uuid, p_actor_user_id uuid, p_setup jsonb) to service_role;
-- Existing routing RPC bodies stay untouched; this new guard applies only to future writes.
create trigger enforce_active_sales_line_token_trigger before insert or update of phone_number_id,handoff_token_sha256,status
on public.sales_phone_assignments for each row execute function public.enforce_active_sales_line_token();
do $$ begin
 if exists(select 1 from prod_phone_before b full join public.sales_phone_numbers p using(id) where b.id is null or p.id is null
   or b.snapshot is distinct from (select jsonb_object_agg(k,v) from jsonb_each(to_jsonb(p)) e(k,v) where b.snapshot ? k))
   or exists(select 1 from prod_assignment_before b full join public.sales_phone_assignments p using(id) where b.id is null or p.id is null or b.snapshot is distinct from to_jsonb(p))
 then raise exception 'prod_sales_line_preservation_failed';end if;
end $$;
commit;
