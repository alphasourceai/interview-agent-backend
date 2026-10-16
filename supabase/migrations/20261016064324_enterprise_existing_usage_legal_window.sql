-- LOCAL/UNMOUNTED: extend the EXISTING usage prepare/reserve snapshot, not a
-- new allocator, invoice engine or collection worker. No existing rows change.
begin;
set local lock_timeout='10s';
do $baseline$
declare r record;p record;
begin
 for r in select * from(values
  ('prepare_enterprise_existing_usage(uuid)','a1b7ad5fb25e01389bc0fd1cf44d9f2d',true),
  ('reserve_enterprise_existing_usage(uuid,integer,text,jsonb,jsonb)','b77a333f05377ce648fbcfc1c2740b95',true),
  ('read_enterprise_existing_legal_window(uuid,uuid)','5092db76ad6873866402860dc7bec7a3',false)
 )v(signature,hash,timed) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.signature);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
   or p.provolatile<>'v' or p.prorettype<>'jsonb'::regtype
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when r.timed then array['search_path=pg_catalog','lock_timeout=10s','statement_timeout=2s']
    else array['search_path=pg_catalog','lock_timeout=10s'] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_usage_legal_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.enterprise_existing_usage_batches'::regclass and relrowsecurity)
  or not exists(select 1 from pg_class where oid='public.usage_billing_ledger'::regclass and relrowsecurity)
  or not exists(select 1 from pg_trigger where tgrelid='public.enterprise_existing_usage_batches'::regclass
   and tgname='enterprise_existing_usage_batch_guard' and tgenabled='O' and tgtype=31
   and tgfoid='public.enterprise_existing_usage_batch_guard()'::regprocedure)
  then raise exception 'enterprise_usage_legal_schema_drift';end if;
end $baseline$;

-- Preserve signatures, OIDs, owner, invoker semantics, ACL and two-second
-- statement deadline. Every substitution requires the reviewed source text.
do $patch$
declare name_ text;body_ text;old_body text;def text;needle text;replacement text;
begin
 foreach name_ in array array['prepare_enterprise_existing_usage(uuid)',
  'reserve_enterprise_existing_usage(uuid,integer,text,jsonb,jsonb)'] loop
  select prosrc,pg_get_functiondef(oid) into body_,def from pg_proc where oid=('public.'||name_)::regprocedure;
  old_body:=body_;
  needle:='receipt jsonb;';replacement:='receipt jsonb;window_ jsonb;';
  if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
  needle:=$x$ start_:=(receipt->'client_initial'->>'contract_start_at')::timestamptz;
 end_:=(receipt->'client_initial'->>'contract_end_at')::timestamptz;$x$;
  replacement:=case when name_ like 'prepare%' then
   $x$ window_:=public.read_enterprise_existing_legal_window(agm,p_owner);$x$
   else $x$ window_:=public.read_enterprise_existing_legal_window(b.agreement_id,owner_);$x$ end||$x$
 start_:=(window_->>'initial_term_start')::timestamptz;
 end_:=(window_->>'term_end_at')::timestamptz;$x$;
  if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
  needle:=$x$'version','enterprise_existing_usage_snapshot_v1'$x$;
  if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;
  body_:=replace(body_,needle,$x$'version','enterprise_existing_usage_snapshot_v2'$x$);
  if name_ like 'prepare%' then
   needle:=$x$'agreement_id',agm,'receipt',receipt,'history',history_,$x$;
   replacement:=$x$'agreement_id',agm,'receipt',receipt,'history',history_,'legal_window',window_,$x$;
   if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
   needle:=$x$'observed_at',to_char(clock_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')$x$;
   replacement:=$x$'observed_at',to_char(clock_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')$x$;
   if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
   needle:=$x$b.snapshot-'observed_at'=document_-'observed_at'$x$;
   replacement:=$x$(b.snapshot-array['observed_at','legal_window'])=(document_-array['observed_at','legal_window'])
   and((b.snapshot->'legal_window')-'observed_at')=(window_-'observed_at')$x$;
   if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
  else
   needle:=$x$'agreement_id',b.agreement_id,'receipt',receipt,'history',history_,'observed_at',b.snapshot->>'observed_at',$x$;
   replacement:=$x$'agreement_id',b.agreement_id,'receipt',receipt,'history',history_,
  'legal_window',jsonb_set(window_,array['observed_at'],b.snapshot->'legal_window'->'observed_at'),
  'observed_at',b.snapshot->>'observed_at',$x$;
   if position(needle in body_)=0 then raise exception 'enterprise_usage_legal_patch_drift';end if;body_:=replace(body_,needle,replacement);
  end if;
  execute replace(def,old_body,body_);
 end loop;
end $patch$;
-- source_identity and all previously reserved rows/digests are deliberately
-- unchanged. Old v1 prepared rows need re-prepare; reserved replay stays exact.
commit;
