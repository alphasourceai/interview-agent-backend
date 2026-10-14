-- LOCAL ONLY. Original scanner writes, not new paid-period/provider authority.
begin;
set local lock_timeout='10s';
create function public.legacy_contract_projection(c public.clients)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('id',c.id,'contract_start_at',c.contract_start_at,'contract_end_at',c.contract_end_at,
  'auto_renew',c.auto_renew,'manual_active_override',c.manual_active_override,'billing_status',c.billing_status,
  'subscription_status',c.subscription_status,'stripe_subscription_id',c.stripe_subscription_id,
  'stripe_customer_id',c.stripe_customer_id,'cancel_at_term_end',c.cancel_at_term_end,
  'cancel_effective_at',c.cancel_effective_at,'plan_tier',c.plan_tier,'billing_interval',c.billing_interval,
  'parent_client_id',c.parent_client_id,'archived_at',c.archived_at);
$$;

create function public.zz_retail_legacy_cohort_gate()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare old_id uuid;new_id uuid;root uuid;needed boolean;
begin
 if exists(select 1 from pg_trigger t where t.tgrelid=TG_RELID and not t.tgisinternal
  and t.tgenabled in('O','A') and (t.tgtype & 3)=3 and (t.tgtype & 28)<>0
  and t.tgname::text collate "C">TG_NAME::text collate "C")
  then raise exception 'legacy_contract_gate_order_unavailable';end if;
 if TG_OP='INSERT' then
  new_id:=NEW.client_id;needed:=NEW.is_current is true or NEW.retail_funding_receipt is not null;
 elsif TG_OP='DELETE' then
  old_id:=OLD.client_id;needed:=OLD.is_current is true or OLD.retail_funding_receipt is not null;
 else
  old_id:=OLD.client_id;new_id:=NEW.client_id;
  needed:=OLD.is_current is true or NEW.is_current is true or OLD.retail_funding_receipt is not null or NEW.retail_funding_receipt is not null;
 end if;
 if needed then
  for root in select distinct x from unnest(array[old_id,new_id]) x where x is not null order by x loop
   perform 1 from public.clients where id=root for share;
   if not found and not(TG_OP='DELETE' and exists(select 1 from pg_roles
    where rolname=current_user and(rolbypassrls or rolsuper)))
    then raise exception 'legacy_contract_gate_root_unavailable';end if;
  end loop;
 end if;
 if TG_OP='DELETE' then return OLD;end if;return NEW;
end $$;
create trigger zz_retail_legacy_cohort_gate before insert or update or delete on public.membership_agreements
 for each row execute function public.zz_retail_legacy_cohort_gate();

create function public.legacy_contract_gate_pin()
returns void language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare p record;
begin
 select * into p from pg_proc where oid=to_regprocedure('public.zz_retail_legacy_cohort_gate()');
 if not found or md5(p.prosrc)<>'__GATE_MD5__' or p.prosecdef or p.provolatile<>'v'
  or p.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
  or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='zz_retail_legacy_cohort_gate' and tgfoid=p.oid and tgenabled='O' and not tgisinternal and tgtype=31)
  or exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass and not tgisinternal
   and tgenabled in('O','A') and(tgtype & 3)=3 and(tgtype & 28)<>0
   and tgname::text collate "C">'zz_retail_legacy_cohort_gate' collate "C")
  then raise exception 'legacy_contract_gate_unavailable';end if;
end $$;
do $pin$ declare p record;body text;h text;
begin
 select md5(prosrc) into h from pg_proc where oid='public.zz_retail_legacy_cohort_gate()'::regprocedure;
 select * into p from pg_proc where oid='public.legacy_contract_gate_pin()'::regprocedure;
 body:=replace(p.prosrc,'__GATE_MD5__',h);execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
end $pin$;

create function public.legacy_contract_cohort(c public.clients)
returns text language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;n integer;
begin
 select count(*) into n from public.membership_agreements where client_id=c.id and is_current is true;
 if n>1 then raise exception 'legacy_contract_source_unavailable';end if;
 if c.billing_interval='prepaid' then return 'held';end if;
 for a in select * from public.membership_agreements where client_id=c.id loop
  if a.retail_funding_receipt is not null then
   if not coalesce(public.retail_existing_funding_receipt_valid(a.retail_funding_receipt,a.checkout_attempt_source),false)
    then raise exception 'legacy_contract_receipt_unavailable';end if;
   return 'held';
  end if;
  if a.is_current is true and(a.billing_option='prepaid' or a.template_version='membership_agreement_retail_terms_v2'
   or a.template_snapshot->>'template_version'='membership_agreement_retail_terms_v2'
   or(a.template_snapshot->'package_snapshot') ?| array['pricing_protocol','membership_terms','pricing_version']) then return 'held';end if;
 end loop;
 return 'legacy';
end $$;

create function public.apply_legacy_contract_action(p_client uuid,p_expected jsonb,p_action text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;e public.clients;after_row public.clients;k text;v jsonb;keys text[];
 required text[]:=array['contract_start_at','contract_end_at','auto_renew','manual_active_override','billing_status',
  'subscription_status','stripe_subscription_id','stripe_customer_id','cancel_at_term_end','cancel_effective_at',
  'plan_tier','billing_interval','parent_client_id','archived_at'];
 action_ok boolean;old_ms timestamp;new_end timestamptz;cohort text;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or p_client is null or p_client='00000000-0000-0000-0000-000000000000'::uuid
  or p_action is null or p_action not in('renew','deactivate','check_cancel','record_cancel')
  or jsonb_typeof(p_expected) is distinct from 'object' then raise exception 'legacy_contract_input_unavailable';end if;
 select array_agg(x order by x) into keys from jsonb_object_keys(p_expected) x;
 if keys is distinct from(select array_agg(x order by x) from unnest(required) x)
  then raise exception 'legacy_contract_input_unavailable';end if;
 for k,v in select * from jsonb_each(p_expected) loop
  if k in('auto_renew','manual_active_override','cancel_at_term_end') then
   if jsonb_typeof(v) not in('null','boolean') then raise exception 'legacy_contract_input_unavailable';end if;
  elsif jsonb_typeof(v) not in('null','string') then raise exception 'legacy_contract_input_unavailable';end if;
 end loop;
 begin e:=jsonb_populate_record(null::public.clients,p_expected);
 exception when others then raise exception 'legacy_contract_input_unavailable';end;
 if(e.contract_start_at is not null and not isfinite(e.contract_start_at))
  or(e.contract_end_at is not null and not isfinite(e.contract_end_at))
  or(e.cancel_effective_at is not null and not isfinite(e.cancel_effective_at))
  or(e.archived_at is not null and not isfinite(e.archived_at))
  then raise exception 'legacy_contract_input_unavailable';end if;
 perform public.legacy_contract_gate_pin();
 -- A SEPARATE statement locks root BEFORE any cohort helper, never a CTE.
 begin select * into strict c from public.clients where id=p_client for update;
 exception when no_data_found then return jsonb_build_object('status','changed','client',null);end;
 perform public.legacy_contract_gate_pin();cohort:=public.legacy_contract_cohort(c);
 if cohort='held' then return jsonb_build_object('status','held','client',public.legacy_contract_projection(c));end if;
 if public.legacy_contract_projection(c)-'id' is distinct from public.legacy_contract_projection(e)-'id'
  or c.manual_active_override is true or c.contract_end_at is null or not isfinite(c.contract_end_at)
  or c.contract_end_at>clock_timestamp() then return jsonb_build_object('status','changed','client',public.legacy_contract_projection(c));end if;
 if p_action='renew' then action_ok:=c.auto_renew is true;
 else action_ok:=c.auto_renew is not true;end if;
 if not action_ok then return jsonb_build_object('status','changed','client',public.legacy_contract_projection(c));end if;
 if p_action='check_cancel' then
  if c.stripe_subscription_id is not null and c.subscription_status in('active','trialing') and c.cancel_at_term_end is not true
   then return jsonb_build_object('status','permitted','client',public.legacy_contract_projection(c));end if;
  return jsonb_build_object('status','unchanged','client',public.legacy_contract_projection(c));
 end if;
 if(p_action='deactivate' and c.billing_status='inactive' and c.cancel_effective_at is not null)
  or(p_action='record_cancel' and c.cancel_at_term_end is true)
  then return jsonb_build_object('status','unchanged','client',public.legacy_contract_projection(c));end if;
 if p_action='record_cancel' and(c.stripe_subscription_id is null or c.subscription_status not in('active','trialing')
  or c.subscription_status is null) then return jsonb_build_object('status','changed','client',public.legacy_contract_projection(c));end if;
 old_ms:=date_trunc('milliseconds',c.contract_end_at at time zone 'UTC');
 -- Match Date.setUTCMonth, including leap Feb29 ->Mar1 rather than SQL clamp.
 new_end:=(date_trunc('month',old_ms)+interval '12 months'
  +make_interval(days:=extract(day from old_ms)::integer-1)+(old_ms-date_trunc('day',old_ms))) at time zone 'UTC';
 if p_action='renew' then
  update public.clients t set contract_start_at=old_ms at time zone 'UTC',contract_end_at=new_end
   where t.id=p_client and public.legacy_contract_projection(t)-'id'=public.legacy_contract_projection(e)-'id'
    and t.manual_active_override is not true and isfinite(t.contract_end_at) and t.contract_end_at<=clock_timestamp()
    and t.auto_renew is true and public.legacy_contract_cohort(t)='legacy' returning t.* into after_row;
 elsif p_action='deactivate' then
  update public.clients t set billing_status='inactive',cancel_effective_at=old_ms at time zone 'UTC'
   where t.id=p_client and public.legacy_contract_projection(t)-'id'=public.legacy_contract_projection(e)-'id'
    and t.manual_active_override is not true and isfinite(t.contract_end_at) and t.contract_end_at<=clock_timestamp()
    and t.auto_renew is not true and public.legacy_contract_cohort(t)='legacy' returning t.* into after_row;
 else
  update public.clients t set cancel_at_term_end=true
   where t.id=p_client and public.legacy_contract_projection(t)-'id'=public.legacy_contract_projection(e)-'id'
    and t.manual_active_override is not true and isfinite(t.contract_end_at) and t.contract_end_at<=clock_timestamp()
    and t.auto_renew is not true and t.stripe_subscription_id is not null and t.subscription_status in('active','trialing')
    and public.legacy_contract_cohort(t)='legacy' returning t.* into after_row;
 end if;
 if found then return jsonb_build_object('status','applied','client',public.legacy_contract_projection(after_row));end if;
 cohort:=public.legacy_contract_cohort(c);
 return jsonb_build_object('status',case when cohort='held' then 'held' else 'changed' end,'client',public.legacy_contract_projection(c));
end $$;

revoke all on function public.legacy_contract_projection(public.clients),public.zz_retail_legacy_cohort_gate(),
 public.legacy_contract_gate_pin(),public.legacy_contract_cohort(public.clients),public.apply_legacy_contract_action(uuid,jsonb,text)
 from public,anon,authenticated;
grant execute on function public.legacy_contract_projection(public.clients),public.zz_retail_legacy_cohort_gate(),
 public.legacy_contract_gate_pin(),public.legacy_contract_cohort(public.clients),public.apply_legacy_contract_action(uuid,jsonb,text)
 to service_role;
commit;
