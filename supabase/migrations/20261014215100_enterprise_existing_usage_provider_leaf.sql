-- LOCAL/UNMOUNTED. Same batches/ledger/entry; no second provider store or route.
-- Trusted server supplies verified SDK projections; this is NOT SQL attestation
-- of Stripe or the JS allocation kernel. Do not include/apply before source gate.
begin;
set local lock_timeout='10s';
alter table public.enterprise_existing_usage_batches add column provider_operation jsonb
 check(provider_operation is null or(jsonb_typeof(provider_operation)='object'
  and octet_length(provider_operation::text)<=16777216));
create unique index enterprise_existing_usage_provider_invoice_idx
 on public.enterprise_existing_usage_batches(account_id,livemode,(provider_operation->>'invoice_id'))
 where provider_operation->>'invoice_id' is not null;

-- Additive patch of reviewed core: provider progress must not enter future
-- service-allocation history or alter already-reserved identity/digests.
do $patch$
declare name_ text;definition_ text;needle_ text;replacement_ text;
begin
 foreach name_ in array array['prepare_enterprise_existing_usage(uuid)',
  'reserve_enterprise_existing_usage(uuid,integer,text,jsonb,jsonb)'] loop
  definition_:=pg_get_functiondef(('public.'||name_)::regprocedure);
  needle_:='to_jsonb(x)-''snapshot'' order by x.service_month,x.id';
  if position(needle_ in definition_)=0 then raise exception 'enterprise_usage_history_patch_drift';end if;
  execute replace(definition_,needle_,'to_jsonb(x)-''snapshot''-''provider_operation'' order by x.service_month,x.id');
 end loop;
 definition_:=pg_get_functiondef('public.enterprise_existing_usage_batch_guard()'::regprocedure);
 needle_:='  if old.phase not in(''prepared'',''held'')';
 replacement_:=$guard$  if old.phase='reserved' and new.phase='reserved'
   and(to_jsonb(new)-'provider_operation')=(to_jsonb(old)-'provider_operation')
   and current_setting('private_sales.enterprise_usage_provider_writer',true)=new.id::text
   then return new;end if;
  if old.phase not in('prepared','held')$guard$;
 if position(needle_ in definition_)=0 then raise exception 'enterprise_usage_batch_guard_patch_drift';end if;
 execute replace(definition_,needle_,replacement_);
 definition_:=pg_get_functiondef('public.enterprise_existing_usage_ledger_guard()'::regprocedure);
 needle_:=' if TG_OP=''UPDATE'' and old.enterprise_usage_batch_id is not null then raise exception ''enterprise_usage_ledger_immutable'';end if;';
 replacement_:=$guard$ if TG_OP='UPDATE' and old.enterprise_usage_batch_id is not null then
  if current_user<>'service_role' or current_setting('private_sales.enterprise_usage_provider_writer',true)
   is distinct from old.enterprise_usage_batch_id::text
   or(to_jsonb(new)-array['stripe_invoice_id','stripe_invoice_item_id','billed_at'])
    is distinct from(to_jsonb(old)-array['stripe_invoice_id','stripe_invoice_item_id','billed_at'])
   or old.stripe_invoice_id is not null or old.stripe_invoice_item_id is not null or old.billed_at is not null
   or new.stripe_invoice_id is null or new.stripe_invoice_item_id is null or new.billed_at is null
   or new.billed_at>clock_timestamp() then raise exception 'enterprise_usage_ledger_immutable';end if;
  select * into strict b from public.enterprise_existing_usage_batches where id=old.enterprise_usage_batch_id;
  if b.provider_operation->'operations'->'finalize'->'proof'->>'stage' is distinct from 'finalized'
   or new.stripe_invoice_id is distinct from b.provider_operation->>'invoice_id'
   or not exists(select 1 from jsonb_array_elements(b.provider_operation->'operations'->'finalize'->'proof'->'items')x
    where x->>'role_id'=new.role_id::text and x->>'invoice_item_id'=new.stripe_invoice_item_id)
   then raise exception 'enterprise_usage_ledger_finalize_proof_required';end if;
  return new;
 end if;$guard$;
 if position(needle_ in definition_)=0 then raise exception 'enterprise_usage_ledger_guard_patch_drift';end if;
 execute replace(definition_,needle_,replacement_);
end $patch$;

create function public.change_enterprise_existing_usage_provider(p_owner uuid,p_batch uuid,p_action text,
 p_generation integer,p_step text,p_lease uuid,p_request jsonb,p_observation jsonb,p_proof jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog
 set lock_timeout='10s' set statement_timeout='2s' as $$
declare b public.enterprise_existing_usage_batches;census_ jsonb;receipt_ jsonb;leaf_ jsonb;op_ jsonb;
 clock_ timestamptz;step_ text;previous_ text;invoice_ text;role_ text;expected_ text;body_ jsonb;
 groups_ jsonb;g jsonb;sum_ bigint;count_ integer;index_ integer;key_json text;request_ jsonb;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or p_owner is null or p_action is null or p_action not in('read','store','claim','sent','observe','stamp')
  then raise exception 'enterprise_usage_provider_input_denied';end if;
 perform set_config('private_sales.enterprise_usage_census_reader',p_owner::text,true);
 census_:=public.enterprise_existing_usage_census(p_owner);
 perform set_config('private_sales.enterprise_usage_census_reader','',true);
 -- Shared census locks original family/seals first; batch lock is last.
 if p_batch is null then
  if p_action<>'read' then raise exception 'enterprise_usage_provider_batch_required';end if;
  select * into b from public.enterprise_existing_usage_batches where owner_id=p_owner and phase='reserved'
   and provider_operation->>'status' is distinct from 'paid' order by service_month,id limit 1 for update;
  if b.id is null then return jsonb_build_object('status','not_due','provider_effect_authorized',false,
   'paid_access_authorized',false,'payroll_authorized',false);end if;
 else
  select * into strict b from public.enterprise_existing_usage_batches where id=p_batch and owner_id=p_owner for update;
 end if;
 if b.phase<>'reserved' or exists(select 1 from public.enterprise_existing_usage_batches x where x.owner_id=p_owner
  and x.service_month<b.service_month and(x.phase not in('reserved','no_usage')
   or(x.phase='reserved' and x.provider_operation->>'status' is distinct from 'paid')))
  then raise exception 'enterprise_usage_provider_older_batch_unresolved';end if;
 receipt_:=public.read_enterprise_existing_billing(b.agreement_id);
 if b.source_identity is distinct from jsonb_build_object('agreement_id',b.agreement_id,
  'owner_id',b.owner_id,'service_month',b.service_month,'receipt',receipt_)
  then raise exception 'enterprise_usage_provider_source_changed';end if;
 clock_:=clock_timestamp();
 leaf_:=coalesce(b.provider_operation,jsonb_build_object('version','enterprise_existing_usage_provider_v1',
  'generation',0,'status','pending','step',null,'lease_id',null,'claimed_until',null,'invoice_id',null,'operations','{}'::jsonb));
 if p_action='read' then return jsonb_build_object('status','read','batch',to_jsonb(b),
  'census',census_,'receipt',receipt_,'observed_at',clock_,'provider_effect_authorized',false,
  'paid_access_authorized',false,'payroll_authorized',false);end if;
 if p_observation is distinct from census_ then raise exception 'enterprise_usage_provider_census_changed';end if;
 if p_generation is distinct from(leaf_->>'generation')::integer
  then raise exception 'enterprise_usage_provider_generation_changed';end if;
 if leaf_->>'status'='paid' then raise exception 'enterprise_usage_provider_already_paid';end if;
 if octet_length(coalesce(p_request,'null'::jsonb)::text)+octet_length(coalesce(p_proof,'null'::jsonb)::text)>16777216
  then raise exception 'enterprise_usage_provider_capacity_held';end if;
 select jsonb_agg(x order by x->>'role_id'),sum((x->>'amount_cents')::bigint),count(*)
  into groups_,sum_,count_ from jsonb_array_elements(b.groups)x;
 if count_<1 or sum_<1 or sum_>2147483647 then raise exception 'enterprise_usage_provider_groups_denied';end if;
 step_:=p_step;invoice_:=leaf_->>'invoice_id';
 if p_action='store' then
  if p_lease is not null or p_proof is not null or jsonb_typeof(p_request) is distinct from 'object'
   or(select count(*) from jsonb_object_keys(p_request))<>2 or not(p_request ?& array['key','body'])
   or jsonb_typeof(p_request->'key')<>'string' or jsonb_typeof(p_request->'body')<>'object'
   then raise exception 'enterprise_usage_provider_request_denied';end if;
  if leaf_->'operations' ? step_ then
   if leaf_->'operations'->step_->'request' is distinct from p_request
    then raise exception 'enterprise_usage_provider_request_immutable';end if;
   return jsonb_build_object('status','stored','leaf',leaf_,'provider_effect_authorized',false,
    'paid_access_authorized',false,'payroll_authorized',false);
  end if;
  previous_:=leaf_->>'step';
  if previous_ is null then expected_:='invoice';
  elsif previous_='invoice' then expected_:='item:'||(groups_->0->>'role_id');
  elsif previous_ like 'item:%' then
   select n::integer into strict index_ from jsonb_array_elements(groups_) with ordinality x(value,n)
    where value->>'role_id'=substring(previous_ from 6);
   expected_:=case when index_<count_ then 'item:'||(groups_->index_->>'role_id') else 'finalize' end;
  elsif previous_='finalize' then expected_:='pay';
  else raise exception 'enterprise_usage_provider_step_terminal';end if;
  if step_ is distinct from expected_ or(previous_ is not null and
   coalesce(leaf_->'operations'->previous_->'proof','null'::jsonb)='null'::jsonb)
   then raise exception 'enterprise_usage_provider_previous_proof_required';end if;
  body_:=p_request->'body';
  if step_='invoice' then
   if p_request->>'key'<>'enterprise-usage-invoice:'||b.id::text
    or body_- 'metadata' is distinct from jsonb_build_object('customer',b.customer_id,'collection_method','charge_automatically',
     'auto_advance',false,'pending_invoice_items_behavior','exclude','currency','usd')
    then raise exception 'enterprise_usage_provider_invoice_request_denied';end if;
  elsif step_ like 'item:%' then
   role_:=substring(step_ from 6);select x into strict g from jsonb_array_elements(groups_)x where x->>'role_id'=role_;
   if invoice_ is null or body_->>'invoice' is distinct from invoice_ or body_->>'customer' is distinct from b.customer_id
    or body_->>'currency' is distinct from 'usd' or body_->'unit_amount' is distinct from g->'unit_price_cents'
    or body_->'quantity' is distinct from g->'quantity' or jsonb_typeof(body_->'description') is distinct from 'string'
    or length(body_->>'description') not between 1 and 4000
    or body_->'period' is distinct from jsonb_build_object('start',extract(epoch from b.service_month::timestamp at time zone 'UTC')::bigint,
     'end',extract(epoch from(b.service_month::timestamp+interval '1 month') at time zone 'UTC')::bigint)
    or(select count(*) from jsonb_object_keys(body_))<>8 then raise exception 'enterprise_usage_provider_item_request_denied';end if;
   key_json:='{"invoiceId":'||to_jsonb(invoice_)::text||',"clientId":'||to_jsonb(b.owner_id::text)::text
    ||',"roleId":'||to_jsonb(role_)::text||',"price":'||(g->>'unit_price_cents')||',"interviews":'
    ||(select replace(jsonb_agg(x order by x)::text,', ',',') from jsonb_array_elements(g->'interview_ids')x)||'}';
   expected_:=encode(sha256(convert_to(key_json,'UTF8')),'hex');
   if p_request->>'key' is distinct from 'usage-item-'||expected_
    or body_->'metadata'->>'role_id' is distinct from role_ or body_->'metadata'->>'usage_operation' is distinct from expected_
    then raise exception 'enterprise_usage_provider_item_key_denied';end if;
  elsif step_='finalize' then
   if invoice_ is null or p_request->>'key'<>'enterprise-usage-finalize:'||b.id::text||':'||invoice_
    or body_ is distinct from '{"auto_advance":false}'::jsonb then raise exception 'enterprise_usage_provider_finalize_request_denied';end if;
  elsif step_='pay' then
   if invoice_ is null or p_request->>'key'<>'enterprise-usage-pay:'||b.id::text||':'||invoice_
    or coalesce(body_->>'payment_method','') !~ '^pm_[A-Za-z0-9_]+$'
    or body_- 'payment_method' is distinct from '{"off_session":true}'::jsonb
    then raise exception 'enterprise_usage_provider_pay_request_denied';end if;
  end if;
  if step_='invoice' or step_ like 'item:%' then
   if body_->'metadata'->>'source' is distinct from 'usage_billing'
    or body_->'metadata'->>'client_id' is distinct from b.owner_id::text
    or body_->'metadata'->>'enterprise_usage_batch_id' is distinct from b.id::text
    then raise exception 'enterprise_usage_provider_metadata_denied';end if;
  end if;
  leaf_:=leaf_||jsonb_build_object('generation',p_generation+1,'step',step_,'lease_id',null,'claimed_until',null,
   'operations',(leaf_->'operations')||jsonb_build_object(step_,jsonb_build_object('request',p_request,'sent_at',null,'proof',null)));
 else
  if step_ is distinct from leaf_->>'step' or not(leaf_->'operations' ? step_)
   then raise exception 'enterprise_usage_provider_step_changed';end if;
  op_:=leaf_->'operations'->step_;
  if p_request is not null then raise exception 'enterprise_usage_provider_request_not_allowed';end if;
  if p_action='claim' then
   if(leaf_->>'claimed_until')::timestamptz>clock_ then return jsonb_build_object('status','busy',
    'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false);end if;
   leaf_:=leaf_||jsonb_build_object('lease_id',gen_random_uuid(),'claimed_until',clock_+interval '30 seconds');
  else
   if p_lease is distinct from(leaf_->>'lease_id')::uuid or p_lease is null
    or(leaf_->>'claimed_until')::timestamptz is null or(leaf_->>'claimed_until')::timestamptz<clock_
    then raise exception 'enterprise_usage_provider_lease_expired';end if;
   if p_action='sent' then
    if op_->'proof'<>'null'::jsonb or(op_->>'sent_at' is not null and clock_>(op_->>'sent_at')::timestamptz+interval '22 hours')
     then raise exception 'enterprise_usage_provider_send_window_closed';end if;
    op_:=op_||jsonb_build_object('sent_at',coalesce((op_->>'sent_at')::timestamptz,clock_));
    leaf_:=jsonb_set(leaf_,array['operations',step_],op_);
   elsif p_action='observe' then
    if op_->>'sent_at' is null or jsonb_typeof(p_proof) is distinct from 'object'
     or coalesce(p_proof->>'invoice_id','') !~ '^in_[A-Za-z0-9_]+$'
     or p_proof->'provider_effect_authorized' is distinct from 'false'::jsonb
     or p_proof->'paid_access_authorized' is distinct from 'false'::jsonb
     or p_proof->'payroll_authorized' is distinct from 'false'::jsonb
     then raise exception 'enterprise_usage_provider_proof_denied';end if;
    if op_->'proof'<>'null'::jsonb and op_->'proof' is distinct from p_proof
     then raise exception 'enterprise_usage_provider_proof_immutable';end if;
    if step_='invoice' then
     if p_proof->>'stage' is distinct from 'shell' or p_proof->'total_cents' is distinct from '0'::jsonb
      or p_proof->'items' is distinct from '[]'::jsonb then raise exception 'enterprise_usage_provider_shell_denied';end if;
     leaf_:=leaf_||jsonb_build_object('invoice_id',p_proof->>'invoice_id');invoice_:=p_proof->>'invoice_id';
    elsif p_proof->>'invoice_id' is distinct from invoice_ then raise exception 'enterprise_usage_provider_invoice_changed';end if;
    if step_ like 'item:%' or step_='finalize' then
     select case when step_='finalize' then count_ else n::integer end into strict index_
      from jsonb_array_elements(groups_) with ordinality x(value,n)
      where step_='finalize' or value->>'role_id'=substring(step_ from 6) limit 1;
     select sum((x->>'amount_cents')::bigint) into sum_ from jsonb_array_elements(groups_) with ordinality e(x,n) where n<=index_;
     if p_proof->>'stage' is distinct from(case when step_='finalize' then 'finalized' else 'items' end)
      or p_proof->'total_cents' is distinct from to_jsonb(sum_)
      or jsonb_typeof(p_proof->'items') is distinct from 'array' or jsonb_array_length(p_proof->'items')<>index_
      then raise exception 'enterprise_usage_provider_group_proof_denied';end if;
     for g in select value from jsonb_array_elements(p_proof->'items') with ordinality x(value,n) loop
      if coalesce(g->>'invoice_item_id','') !~ '^ii_[A-Za-z0-9_]+$' or coalesce(g->>'line_id','') !~ '^il_[A-Za-z0-9_]+$'
       then raise exception 'enterprise_usage_provider_item_proof_denied';end if;
     end loop;
     if exists(select 1 from jsonb_array_elements(p_proof->'items') with ordinality x(value,n)
      where value->>'role_id' is distinct from groups_->(n::integer-1)->>'role_id')
      then raise exception 'enterprise_usage_provider_proof_order_denied';end if;
     if(select count(distinct x->>'invoice_item_id') from jsonb_array_elements(p_proof->'items')x)<>index_
      or(select count(distinct x->>'line_id') from jsonb_array_elements(p_proof->'items')x)<>index_
      or exists(select 1 from jsonb_array_elements(p_proof->'items')x where leaf_->'operations' ? ('item:'||(x->>'role_id'))
       and coalesce(leaf_->'operations'->('item:'||(x->>'role_id'))->'proof','null'::jsonb)<>'null'::jsonb
       and not(leaf_->'operations'->('item:'||(x->>'role_id'))->'proof'->'items' @> jsonb_build_array(x)))
      then raise exception 'enterprise_usage_provider_prior_item_proof_changed';end if;
    elsif step_='pay' then
     if p_proof->'amount_cents' is distinct from to_jsonb(sum_) or coalesce(p_proof->>'payment_intent_id','') !~ '^pi_[A-Za-z0-9_]+$'
      or coalesce(p_proof->>'charge_id','') !~ '^ch_[A-Za-z0-9_]+$' or jsonb_typeof(p_proof->'paid_at') is distinct from 'number'
      or(p_proof->>'paid_at')::numeric<>trunc((p_proof->>'paid_at')::numeric)
      or(p_proof->>'paid_at')::numeric>extract(epoch from clock_) or(p_proof->>'paid_at')::numeric<=0
      or(select count(*) from jsonb_object_keys(p_proof))<>8 then raise exception 'enterprise_usage_provider_cash_proof_denied';end if;
     leaf_:=leaf_||'{"status":"paid"}'::jsonb;
    end if;
    op_:=op_||jsonb_build_object('proof',p_proof);leaf_:=jsonb_set(leaf_,array['operations',step_],op_);
   elsif p_action='stamp' then
    if leaf_->'operations'->'finalize'->'proof'->>'stage' is distinct from 'finalized'
     then raise exception 'enterprise_usage_provider_finalize_proof_required';end if;
    perform set_config('private_sales.enterprise_usage_provider_writer',b.id::text,true);
    for g in select * from jsonb_array_elements(leaf_->'operations'->'finalize'->'proof'->'items') loop
     update public.usage_billing_ledger set stripe_invoice_id=invoice_,stripe_invoice_item_id=g->>'invoice_item_id',billed_at=clock_
      where enterprise_usage_batch_id=b.id and role_id=(g->>'role_id')::uuid and stripe_invoice_id is null
       and stripe_invoice_item_id is null and billed_at is null;
    end loop;
    if exists(select 1 from public.usage_billing_ledger l where l.enterprise_usage_batch_id=b.id
     and(l.stripe_invoice_id is distinct from invoice_ or l.stripe_invoice_item_id is null or l.billed_at is null))
     then raise exception 'enterprise_usage_provider_partial_stamp_denied';end if;
   else raise exception 'enterprise_usage_provider_action_denied';end if;
  end if;
 end if;
 perform set_config('private_sales.enterprise_usage_writer',b.id::text,true);
 perform set_config('private_sales.enterprise_usage_provider_writer',b.id::text,true);
 update public.enterprise_existing_usage_batches set provider_operation=leaf_ where id=b.id;
 perform set_config('private_sales.enterprise_usage_provider_writer','',true);
 perform set_config('private_sales.enterprise_usage_writer','',true);
 return jsonb_build_object('status',p_action,'leaf',leaf_,'provider_effect_authorized',false,
  'paid_access_authorized',false,'payroll_authorized',false);
end $$;
revoke all on function public.change_enterprise_existing_usage_provider(uuid,uuid,text,integer,text,uuid,jsonb,jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function public.change_enterprise_existing_usage_provider(uuid,uuid,text,integer,text,uuid,jsonb,jsonb,jsonb) to service_role;
commit;
