begin;

-- Supabase installs pgcrypto in the extensions schema. The two Recovery-Core
-- security-definer RPCs use an empty search_path and must not depend on a
-- public.digest compatibility alias. PostgreSQL's built-in sha256(bytea)
-- provides the same digest bytes without an extension-schema dependency.
do $digest_schema_compatibility$
declare
  v_authorize_signature constant text :=
    'public.authorize_interview_replacement_core(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean,uuid)';
  v_finalize_signature constant text :=
    'public.finalize_interview_final_transcript_reconciliation(uuid,text,uuid,bigint,text,text,text,text,jsonb,jsonb,text)';
  v_authorize_oid oid;
  v_finalize_oid oid;
  v_definition text;
  v_rewritten text;
  v_authorize_prefix constant text :=
    'public.digest(convert_to(concat_ws(''|'',';
  v_authorize_prefix_replacement constant text :=
    'pg_catalog.sha256(convert_to(concat_ws(''|'',';
  v_authorize_suffix constant text :=
    '  ), ''utf8''), ''sha256''), ''hex'');';
  v_authorize_suffix_replacement constant text :=
    '  ), ''utf8'')), ''hex'');';
  v_finalize_expression constant text :=
    'encode(public.digest(convert_to(p_normalized_transcript, ''UTF8''), ''sha256''), ''hex'')';
  v_finalize_expression_replacement constant text :=
    'encode(pg_catalog.sha256(convert_to(p_normalized_transcript, ''UTF8'')), ''hex'')';
begin
  if pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'recovery_digest_schema_compatibility_missing_sha256';
  end if;

  v_authorize_oid := pg_catalog.to_regprocedure(v_authorize_signature)::oid;
  v_finalize_oid := pg_catalog.to_regprocedure(v_finalize_signature)::oid;
  if v_authorize_oid is null or v_finalize_oid is null then
    raise exception using
      errcode = 'P0001',
      message = 'recovery_digest_schema_compatibility_function_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_authorize_oid);
  if pg_catalog.strpos(v_definition, v_authorize_prefix) > 0
    and pg_catalog.strpos(v_definition, v_authorize_suffix) > 0 then
    v_rewritten := pg_catalog.replace(
      pg_catalog.replace(
        v_definition,
        v_authorize_prefix,
        v_authorize_prefix_replacement
      ),
      v_authorize_suffix,
      v_authorize_suffix_replacement
    );
    if v_rewritten = v_definition
      or pg_catalog.strpos(v_rewritten, 'public.digest(') > 0
      or pg_catalog.strpos(v_rewritten, 'pg_catalog.sha256(') = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'recovery_digest_schema_compatibility_authorize_rewrite_failed';
    end if;
    execute v_rewritten;
  elsif pg_catalog.strpos(v_definition, 'pg_catalog.sha256(') = 0
    or pg_catalog.strpos(v_definition, 'public.digest(') > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'recovery_digest_schema_compatibility_authorize_contract_mismatch';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_finalize_oid);
  if pg_catalog.strpos(v_definition, v_finalize_expression) > 0 then
    v_rewritten := pg_catalog.replace(
      v_definition,
      v_finalize_expression,
      v_finalize_expression_replacement
    );
    if v_rewritten = v_definition
      or pg_catalog.strpos(v_rewritten, 'public.digest(') > 0
      or pg_catalog.strpos(v_rewritten, 'pg_catalog.sha256(') = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'recovery_digest_schema_compatibility_finalize_rewrite_failed';
    end if;
    execute v_rewritten;
  elsif pg_catalog.strpos(v_definition, 'pg_catalog.sha256(') = 0
    or pg_catalog.strpos(v_definition, 'public.digest(') > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'recovery_digest_schema_compatibility_finalize_contract_mismatch';
  end if;

  if pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(v_authorize_oid),
      'pg_catalog.sha256('
    ) = 0
    or pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(v_authorize_oid),
      'public.digest('
    ) > 0
    or pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(v_finalize_oid),
      'pg_catalog.sha256('
    ) = 0
    or pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(v_finalize_oid),
      'public.digest('
    ) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'recovery_digest_schema_compatibility_postcondition_failed';
  end if;
end
$digest_schema_compatibility$;

commit;
