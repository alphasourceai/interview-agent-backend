-- LOCAL UNMOUNTED: original buyer membership write, not Auth or renewal engine.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in('retail_admin_existing_member_schema_guard','retail_admin_existing_member_context',
   'retail_admin_existing_member_commit_guard','ensure_retail_existing_admin_buyer_member'))
  or exists(select 1 from pg_trigger where tgrelid='public.client_members'::regclass
   and tgname='retail_admin_existing_member_commit_guard')
  then raise exception 'retail_admin_member_schema_drift';end if;
end $baseline$;

create function public.retail_admin_existing_member_schema_guard()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare spec text[];m record;
begin
 perform public.retail_admin_existing_billing_schema_guard();
 foreach spec slice 1 in array array[
  array['retail_admin_existing_billing_schema_guard()','548328390883f859fee30596f862a6fc','s',''],
  array['retail_admin_existing_billing_context(public.membership_agreements)','59b22208facb0b69da28e2ad6267c454','v',''],
  array['retail_admin_existing_billing_receipt_valid(jsonb,jsonb,jsonb)','2f976b6bcbfe716b5fb2a3eaa76e41e9','i',''],
  array['retail_admin_existing_billing_guard()','6b8fe53d542567b6b9da603aa9dcf0c7','v',''],
  array['retail_admin_existing_billing_commit_guard()','dac9e476d4687575f17a691b3f38c358','v',''],
  array['apply_retail_existing_admin_billing(uuid,uuid,jsonb,jsonb,jsonb,jsonb)','045f2f4abf8fe9e8f2e68d4029c4d2cf','v','lock']] loop
  select * into m from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(m.prosrc) is distinct from spec[2] or m.prosecdef or m.proisstrict or m.provolatile::text<>spec[3]
   or m.proconfig is distinct from(case when spec[4]='lock' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
   or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or not has_function_privilege('service_role',m.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
    where grantee not in(m.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'retail_admin_member_prerequisite_drift';end if;
 end loop;
 select * into m from pg_proc where oid=to_regprocedure('public.client_members_sync_user_uuid()');
 if not found or md5(m.prosrc) is distinct from '83ae4c2f6bfa99df42c8371cda6a1c0c' or m.prosecdef or m.proisstrict
  or m.provolatile<>'v' or m.proconfig is not null or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or m.proacl::text is distinct from '{postgres=X/postgres,=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  then raise exception 'retail_admin_member_trigger_drift';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.client_members'::regclass
   and tgname='trg_client_members_sync_user_uuid' and tgtype=23 and tgenabled='O' and not tgisinternal
   and tgfoid='public.client_members_sync_user_uuid()'::regprocedure)
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='retail_admin_existing_billing_guard' and tgtype=31 and tgenabled='O' and not tgisinternal
   and tgfoid='public.retail_admin_existing_billing_guard()'::regprocedure)
  or not exists(select 1 from pg_trigger where tgrelid='public.membership_agreements'::regclass
   and tgname='retail_admin_existing_billing_commit_guard' and tgtype=17 and tgenabled='O' and not tgisinternal and tgdeferrable and tginitdeferred
   and tgfoid='public.retail_admin_existing_billing_commit_guard()'::regprocedure)
  then raise exception 'retail_admin_member_trigger_drift';end if;
 if not exists(select 1 from pg_class where oid='public.client_members'::regclass and relrowsecurity)
  or not has_table_privilege('service_role','public.client_members','SELECT')
  or not has_table_privilege('service_role','public.client_members','INSERT')
  or not has_table_privilege('service_role','public.client_members','UPDATE')
  or not exists(select 1 from pg_index where indexrelid=to_regclass('public.client_members_pkey')
   and indrelid='public.client_members'::regclass and indisunique and indisvalid and indisready and indislive and indimmediate
   and pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX client_members_pkey ON public.client_members USING btree (client_id, user_id)')
  then raise exception 'retail_admin_member_schema_drift';end if;
 -- Initial migration check runs before these functions exist. At runtime the
 -- RPC exists, so enforce exact new context/commit/RPC metadata and trigger.
 if to_regprocedure('public.ensure_retail_existing_admin_buyer_member(uuid,jsonb,jsonb,jsonb,uuid,text)') is not null then
  foreach spec slice 1 in array array[
   array['retail_admin_existing_member_context(uuid,jsonb,jsonb,jsonb)','550c4c9110a525944e77e009dd44271d','lock'],
   array['retail_admin_existing_member_commit_guard()','e185718e1f2766d1ada704f0c4fd0df5',''],
   array['ensure_retail_existing_admin_buyer_member(uuid,jsonb,jsonb,jsonb,uuid,text)','29e8576764085dcfc24f248264aa69b6','lock']] loop
   select * into m from pg_proc where oid=to_regprocedure('public.'||spec[1]);
   if not found or md5(m.prosrc) is distinct from spec[2] or m.prosecdef or m.proisstrict or m.provolatile<>'v'
    or m.proconfig is distinct from(case when spec[3]='lock' then array['search_path=pg_catalog','lock_timeout=10s'] else array['search_path=pg_catalog'] end)
    or m.proowner is distinct from(select oid from pg_roles where rolname='postgres')
    or not has_function_privilege('service_role',m.oid,'EXECUTE')
    or exists(select 1 from aclexplode(coalesce(m.proacl,acldefault('f',m.proowner)))
     where grantee not in(m.proowner,(select oid from pg_roles where rolname='service_role')))
    or(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=m.proname)<>1
    then raise exception 'retail_admin_member_prerequisite_drift';end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.client_members'::regclass and tgname='retail_admin_existing_member_commit_guard'
   and tgtype=21 and tgenabled='O' and not tgisinternal and tgdeferrable and tginitdeferred
   and tgfoid='public.retail_admin_existing_member_commit_guard()'::regprocedure)
   then raise exception 'retail_admin_member_trigger_drift';end if;
 end if;
end $$;
revoke all on function public.retail_admin_existing_member_schema_guard() from public,anon,authenticated;
grant execute on function public.retail_admin_existing_member_schema_guard() to service_role;
select public.retail_admin_existing_member_schema_guard();

create function public.retail_admin_existing_member_context(p_agreement uuid,p_source jsonb,p_receipt jsonb,p_current jsonb)
returns public.membership_agreements language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;c public.clients;clock timestamptz;period_at timestamptz;
begin
 if current_user<>'service_role' then raise exception 'retail_admin_member_server_only';end if;
 perform public.retail_admin_existing_member_schema_guard();
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.checkout_attempt_source is distinct from p_source or a.retail_admin_billing_receipt is null
  or a.retail_admin_billing_receipt is distinct from p_receipt
  then raise exception 'retail_admin_member_source_denied';end if;
 select * into c from public.clients where id=a.client_id for update;
 perform 1 from public.billing_customers where stripe_customer_id=p_source->>'customer_id' order by id for share;
 perform public.retail_admin_existing_billing_context(a);
 if not coalesce(public.retail_admin_existing_billing_receipt_valid(p_receipt,p_source,a.retail_funding_receipt),false)
  then raise exception 'retail_admin_member_receipt_denied';end if;
 if not coalesce(public.retail_existing_closed_object(p_current,array['id','customer','status','current_period_end',
  'cancel_at_period_end','cancel_at','pause_collection']),false)
  or p_current-array['cancel_at_period_end','cancel_at','pause_collection'] is distinct from(p_receipt->'subscription')-'cancel_at_period_end'
  or jsonb_typeof(p_current->'cancel_at_period_end') is distinct from 'boolean'
  or not(case when p_current->'cancel_at'='null'::jsonb then true
   when jsonb_typeof(p_current->'cancel_at')='number' and p_current->>'cancel_at' ~ '^[0-9]+$'
    then(p_current->>'cancel_at')::numeric between(p_receipt->'subscription'->>'current_period_end')::numeric and 253402300799
   else false end)
  or p_current->'pause_collection' is distinct from 'null'::jsonb
  then raise exception 'retail_admin_member_current_subscription_denied';end if;
 period_at:=to_timestamp((p_receipt->'subscription'->>'current_period_end')::bigint);
 clock:=clock_timestamp();
 if(p_receipt->>'applied_at')::timestamptz>clock or period_at<=clock or c.contract_end_at<=clock
  then raise exception 'retail_admin_member_paid_period_ended';end if;
 if c.billing_status is distinct from 'active' or c.subscription_status is distinct from 'active'
  or c.current_term_end is distinct from period_at
  or c.contract_start_at is distinct from(p_receipt->'client_initial'->>'contract_start_at')::timestamptz
  or c.contract_end_at is distinct from(p_receipt->'client_initial'->>'contract_end_at')::timestamptz
  or c.access_override_mode is null or c.access_override_mode not in('inherit','force_active')
  then raise exception 'retail_admin_member_current_access_denied';end if;
 return a;
end $$;

create function public.retail_admin_existing_member_commit_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare binding jsonb;a public.membership_agreements;r public.client_members;matches integer;
begin
 binding:=coalesce(nullif(current_setting('private_sales.retail_admin_member_contexts',true),''),'{}')::jsonb
  ->(new.client_id::text||':'||new.user_id::text);
 if binding is null then return null;end if;
 a:=public.retail_admin_existing_member_context((binding->>'agreement_id')::uuid,binding->'source',binding->'receipt',binding->'current');
 select count(*) into matches from public.client_members where client_id=a.client_id
  and(user_id=new.user_id or lower(btrim(email))=lower(btrim(a.admin_email)));
 select * into r from public.client_members where client_id=new.client_id and user_id=new.user_id;
 if not found or matches<>1 or a.client_id is distinct from new.client_id or r.user_id_uuid is distinct from new.user_id
  or lower(btrim(r.email)) is distinct from lower(btrim(a.admin_email)) or r.role is distinct from binding->>'role'
  then raise exception 'retail_admin_member_commit_identity_denied';end if;return null;
end $$;
create constraint trigger retail_admin_existing_member_commit_guard after insert or update on public.client_members
 deferrable initially deferred for each row execute function public.retail_admin_existing_member_commit_guard();

create function public.ensure_retail_existing_admin_buyer_member(p_agreement uuid,p_source jsonb,p_receipt jsonb,p_current jsonb,p_user uuid,p_name text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare a public.membership_agreements;r public.client_members;matches integer;buyer text;buyer_name text:=nullif(btrim(p_name),'');
 role_name text;new_name text;new_email text;binding jsonb;contexts jsonb;key text;result text;
begin
 if p_user is null or p_user='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'retail_admin_member_user_denied';end if;
 a:=public.retail_admin_existing_member_context(p_agreement,p_source,p_receipt,p_current);
 buyer:=lower(btrim(a.admin_email));
 if buyer is null or buyer='' then raise exception 'retail_admin_member_buyer_denied';end if;
 matches:=0;
 for r in select * from public.client_members where client_id=a.client_id and(user_id=p_user or lower(btrim(email))=buyer)
  order by user_id for update loop
  matches:=matches+1;if matches>1 then raise exception 'retail_admin_member_identity_conflict';end if;
 end loop;
 if matches=1 and(r.user_id is distinct from p_user or(nullif(btrim(r.email),'') is not null and lower(btrim(r.email)) is distinct from buyer))
  then raise exception 'retail_admin_member_identity_conflict';end if;
 role_name:=case when lower(btrim(r.role)) in('manager','admin','owner','super_admin') then lower(btrim(r.role)) else 'manager' end;
 new_name:=case when nullif(btrim(r.name),'') is null then buyer_name else r.name end;
 new_email:=case when nullif(btrim(r.email),'') is null then buyer else r.email end;
 key:=a.client_id::text||':'||p_user::text;
 binding:=jsonb_build_object('agreement_id',a.id,'source',p_source,'receipt',p_receipt,'current',p_current,'role',role_name);
 contexts:=coalesce(nullif(current_setting('private_sales.retail_admin_member_contexts',true),''),'{}')::jsonb;
 if contexts?key and contexts->key is distinct from binding then raise exception 'retail_admin_member_binding_conflict';end if;
 perform set_config('private_sales.retail_admin_member_contexts',jsonb_set(contexts,array[key],binding)::text,true);
 -- Same locks retained; recheck fresh clock AFTER every member wait, before DML.
 perform public.retail_admin_existing_member_context(p_agreement,p_source,p_receipt,p_current);
 if matches=0 then
  begin
   insert into public.client_members(client_id,user_id,email,name,role) values(a.client_id,p_user,buyer,buyer_name,'manager');
   result:='created';
  exception when unique_violation then
   -- Original same-PK adoption strategy, but revalidate every identity candidate.
   matches:=0;
   for r in select * from public.client_members where client_id=a.client_id and(user_id=p_user or lower(btrim(email))=buyer)
    order by user_id for update loop matches:=matches+1;end loop;
   if matches<>1 or r.user_id is distinct from p_user or lower(btrim(r.email)) is distinct from buyer or r.role is distinct from 'manager'
    then raise exception 'retail_admin_member_identity_conflict';end if;
   result:='existing';
  end;
 elsif new_name is distinct from r.name or new_email is distinct from r.email or role_name is distinct from r.role then
  update public.client_members set name=new_name,email=new_email,role=role_name where client_id=a.client_id and user_id=p_user;
  result:='updated';
 else result:='existing';end if;
 -- Lock/recheck every candidate again after INSERT/adoption/UPDATE. The held
 -- root-client FOR UPDATE already serializes every native caller for this
 -- client, including different user ids; no email-unique-index assumption.
 matches:=0;
 for r in select * from public.client_members where client_id=a.client_id and(user_id=p_user or lower(btrim(email))=buyer)
  order by user_id for update loop matches:=matches+1;end loop;
 if matches<>1 or r.user_id is distinct from p_user or r.user_id_uuid is distinct from p_user
  or lower(btrim(r.email)) is distinct from buyer or r.role is distinct from role_name
  then raise exception 'retail_admin_member_identity_conflict';end if;
 perform public.retail_admin_existing_member_context(p_agreement,p_source,p_receipt,p_current);
 return jsonb_build_object('status',result,'role',role_name);
end $$;

revoke all on function public.retail_admin_existing_member_context(uuid,jsonb,jsonb,jsonb),
 public.retail_admin_existing_member_commit_guard(),public.ensure_retail_existing_admin_buyer_member(uuid,jsonb,jsonb,jsonb,uuid,text)
 from public,anon,authenticated;
grant execute on function public.retail_admin_existing_member_context(uuid,jsonb,jsonb,jsonb),
 public.retail_admin_existing_member_commit_guard(),public.ensure_retail_existing_admin_buyer_member(uuid,jsonb,jsonb,jsonb,uuid,text) to service_role;
commit;
