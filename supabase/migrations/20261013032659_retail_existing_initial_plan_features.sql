-- Local candidate only: reuse the existing locked billing writer/signature.
-- Apply AFTER Mihran's model/interview columns and retail existing-flow terms.
-- No backfill, new table/RPC arguments, Auth, access grant, or provider action.
begin;
do $migration$
declare
  sig text := 'public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)';
  proc_oid oid; definition text; original_acl aclitem[]; original_owner oid;
  original_config text[]; marker text; replacement text;
  legacy_insert text := $source$  insert into public.client_plan_settings (
    client_id, plan_tier, billing_interval, platform_fee,
    per_role_fee, included_interviews_per_role, additional_interview_fee,
    max_interview_minutes
  ) values (
    p_client_id, p_plan_tier, p_billing_interval, p_platform_fee,
    p_per_role_fee, p_included_interviews_per_role, p_additional_interview_fee,
    p_max_interview_minutes
  ) on conflict (client_id) do update set
    plan_tier = excluded.plan_tier,
    billing_interval = excluded.billing_interval,
    platform_fee = excluded.platform_fee,
    per_role_fee = excluded.per_role_fee,
    included_interviews_per_role = excluded.included_interviews_per_role,
    additional_interview_fee = excluded.additional_interview_fee,
    max_interview_minutes = excluded.max_interview_minutes,
    updated_at = v_now;$source$;
begin
  -- Exact existing column semantics, not a weaker fixture-only approximation.
  if not exists(select 1 from pg_attribute a where a.attrelid='public.client_plan_settings'::regclass
    and a.attname='scored_question_count' and a.atttypid='integer'::regtype and not a.attisdropped)
    or not exists(select 1 from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.client_plan_settings'::regclass and a.attname='billing_model'
        and a.atttypid='text'::regtype and not a.attnotnull and not a.attisdropped and d.oid is null)
    or not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.client_plan_settings'::regclass and a.attname='rollover_days'
        and a.atttypid='integer'::regtype and a.attnotnull and not a.attisdropped
        and pg_get_expr(d.adbin,d.adrelid)='90')
    or not exists(select 1 from pg_constraint where conrelid='public.client_plan_settings'::regclass
      and conname='client_plan_settings_rollover_days_check' and contype='c' and convalidated
      and pg_get_constraintdef(oid)='CHECK ((rollover_days > 0))')
  then raise exception 'retail_initial_features_schema_prerequisite'; end if;

  -- Earlier local-only candidate used a shorter digest. Never rewrite its data
  -- or dual-accept receipts. Applied LEGACY records do not match this predicate.
  if exists(select 1 from public.public_purchase_intents where billing_applied_at is not null
    and package_snapshot ?| array['pricing_protocol','membership_terms','pricing_version'])
  then raise exception 'retail_initial_features_already_applied_manual_review'; end if;

  proc_oid := to_regprocedure(sig);
  select pg_get_functiondef(p.oid),p.proacl,p.proowner,p.proconfig
    into definition,original_acl,original_owner,original_config from pg_proc p where p.oid=proc_oid;
  if definition is null or not (select p.prosecdef from pg_proc p where p.oid=proc_oid)
    or original_config is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon',proc_oid,'EXECUTE')
    or has_function_privilege('authenticated',proc_oid,'EXECUTE')
    or not has_function_privilege('service_role',proc_oid,'EXECUTE')
    or strpos(definition,'select * into v_intent from public.public_purchase_intents')=0
    or strpos(definition,'select * into v_agreement from public.membership_agreements')
      <= strpos(definition,'select * into v_intent from public.public_purchase_intents')
    or strpos(definition,'select * into v_client from public.clients')
      <= strpos(definition,'select * into v_agreement from public.membership_agreements')
    or strpos(definition,'select * into v_plan from public.client_plan_settings')
      <= strpos(definition,'select * into v_client from public.clients')
    or (length(definition)-length(replace(definition,legacy_insert,'')))/length(legacy_insert)<>1
    or (length(definition)-length(replace(definition,
      'v_retail_months := public.retail_existing_terms_months(to_jsonb(v_agreement),to_jsonb(v_intent));','')))
      /length('v_retail_months := public.retail_existing_terms_months(to_jsonb(v_agreement),to_jsonb(v_intent));')<>1
  then raise exception 'retail_initial_features_writer_source_drift'; end if;

  -- Extend the existing digest ONLY for new retail. Legacy array||[] has the
  -- identical canonical text/digest; fixed binds accepted JSON null, not the
  -- stored/default unused positive duration. Replay still returns before DML.
  marker := 'convert_to(jsonb_build_array(';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1
  then raise exception 'retail_initial_features_digest_source_drift'; end if;
  definition := replace(definition,marker,'convert_to((jsonb_build_array(');
  marker := E'    v_credit_tuple\n  )::text, ''UTF8''), ''sha256''), ''hex'');';
  replacement := $digest$    v_credit_tuple
  ) || case when v_retail_months > 0 then jsonb_build_array(
    v_intent.package_snapshot->'membership_terms'->'scored_question_count',
    v_intent.package_snapshot->'membership_terms'->'billing_model',
    v_intent.package_snapshot->'membership_terms'->'rollover_days'
  ) else '[]'::jsonb end)::text, 'UTF8'), 'sha256'), 'hex');$digest$;
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1
  then raise exception 'retail_initial_features_digest_source_drift'; end if;
  definition := replace(definition,marker,replacement);

  replacement := $settings$  if v_retail_months > 0 then
    if v_intent.package_snapshot->'membership_terms'->>'billing_model' = 'rollover' then
      insert into public.client_plan_settings (
        client_id,plan_tier,billing_interval,platform_fee,per_role_fee,
        included_interviews_per_role,additional_interview_fee,max_interview_minutes,
        scored_question_count,billing_model,rollover_days
      ) values (
        p_client_id,p_plan_tier,p_billing_interval,p_platform_fee,p_per_role_fee,
        p_included_interviews_per_role,p_additional_interview_fee,p_max_interview_minutes,
        (v_intent.package_snapshot->'membership_terms'->>'scored_question_count')::integer,
        v_intent.package_snapshot->'membership_terms'->>'billing_model',
        (v_intent.package_snapshot->'membership_terms'->>'rollover_days')::integer
      ) on conflict(client_id) do update set
        plan_tier=excluded.plan_tier,billing_interval=excluded.billing_interval,platform_fee=excluded.platform_fee,
        per_role_fee=excluded.per_role_fee,included_interviews_per_role=excluded.included_interviews_per_role,
        additional_interview_fee=excluded.additional_interview_fee,max_interview_minutes=excluded.max_interview_minutes,
        scored_question_count=excluded.scored_question_count,billing_model=excluded.billing_model,
        rollover_days=excluded.rollover_days,updated_at=v_now;
    else
      -- Omit fixed rollover on insert (real DB default applies) AND conflict
      -- (a pre-existing positive unused value survives, never EXCLUDED.default).
      insert into public.client_plan_settings (
        client_id,plan_tier,billing_interval,platform_fee,per_role_fee,
        included_interviews_per_role,additional_interview_fee,max_interview_minutes,
        scored_question_count,billing_model
      ) values (
        p_client_id,p_plan_tier,p_billing_interval,p_platform_fee,p_per_role_fee,
        p_included_interviews_per_role,p_additional_interview_fee,p_max_interview_minutes,
        (v_intent.package_snapshot->'membership_terms'->>'scored_question_count')::integer,
        v_intent.package_snapshot->'membership_terms'->>'billing_model'
      ) on conflict(client_id) do update set
        plan_tier=excluded.plan_tier,billing_interval=excluded.billing_interval,platform_fee=excluded.platform_fee,
        per_role_fee=excluded.per_role_fee,included_interviews_per_role=excluded.included_interviews_per_role,
        additional_interview_fee=excluded.additional_interview_fee,max_interview_minutes=excluded.max_interview_minutes,
        scored_question_count=excluded.scored_question_count,billing_model=excluded.billing_model,updated_at=v_now;
    end if;
  else
$settings$ || legacy_insert || E'\n  end if;';
  definition := replace(definition,legacy_insert,replacement);
  execute definition;
  if not exists(select 1 from pg_proc p where p.oid=proc_oid and p.prosecdef
    and p.proowner=original_owner and p.proacl is not distinct from original_acl
    and p.proconfig is not distinct from original_config)
  then raise exception 'retail_initial_features_writer_privilege_drift'; end if;
end $migration$;
commit;
