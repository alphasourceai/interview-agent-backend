-- LOCAL candidate: existing admin-reviewed payroll ledger only. No cash,
-- settlement, ACH, provider, access or customer-account writer/backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare p record;r record;
begin
 if to_regprocedure('public.read_enterprise_existing_commission_payment(uuid,uuid,text,uuid,boolean)') is not null
  or exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
   and attname in('enterprise_agreement_id','enterprise_commission_source') and not attisdropped)
  -- This release uses the existing ledger, not the retired contract stack.
  or to_regprocedure('public.membership_v2_check_commission_receipt()') is not null
  then raise exception 'enterprise_commission_schema_drift';end if;
 for r in select * from(values
  ('require_sales_commission_sales_assisted()','701caccedf222663e8196af238773e36','trigger'),
  ('reject_sales_commission_ledger_mutation()','60e25f1abc2aff6f5a02d1ed0b1c40c9','trigger'),
  ('check_sales_commission_departure_cutoff()','030f985df12a23358849d9343cf70b80','trigger'),
  ('check_sales_commission_week_unlocked()','10ef36caf48a5cb65f777328d1393767','trigger'),
  ('check_sales_commission_receipt_balance()','9076bbf8ad26c2a27a09e8efef9c584f','trigger'),
  ('read_enterprise_existing_billing(uuid)','6f0719620d7073a463b8fc6a6a8b4808','jsonb'),
  ('read_enterprise_existing_paid_coverage(uuid,uuid)','e1a325ef638902d552636d73f6ae3460','jsonb'),
  ('enterprise_existing_period_proof_valid(jsonb,public.membership_agreements)','fcbb9b7ba46a9ba44fcbf7b49bcf17b0','boolean')
 )v(sig,hash,result_type) loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||r.sig);
  if not found or md5(p.prosrc) is distinct from r.hash or p.prosecdef or p.proretset or p.proisstrict
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.prorettype is distinct from r.result_type::regtype or p.proparallel<>'u'
   or p.prolang is distinct from(select oid from pg_language where lanname='plpgsql')
   or p.provolatile is distinct from(case when r.sig like 'enterprise_existing_period_proof_valid%' then 'i'::"char" else 'v'::"char" end)
   or p.proconfig is distinct from(case
    when r.sig in('require_sales_commission_sales_assisted()','check_sales_commission_receipt_balance()') then array['search_path=""']::text[]
    when r.sig like 'read_enterprise_existing_%' then array['search_path=pg_catalog','lock_timeout=10s']::text[]
    when r.sig like 'enterprise_existing_period_proof_valid%' then array['search_path=pg_catalog']::text[] else null::text[] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    where x.privilege_type='EXECUTE' and x.grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   then raise exception 'enterprise_commission_prerequisite_drift';end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.sales_commission_receipts'::regclass and relrowsecurity)
  or has_table_privilege('anon','public.sales_commission_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or has_table_privilege('authenticated','public.sales_commission_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or not has_table_privilege('service_role','public.sales_commission_receipts','SELECT')
  or not has_table_privilege('service_role','public.sales_commission_receipts','INSERT')
  or not has_table_privilege('service_role','public.sales_commission_receipts','UPDATE')
  or has_table_privilege('service_role','public.sales_commission_receipts','DELETE,TRUNCATE')
  or not exists(select 1 from pg_attribute where attrelid='public.sales_commission_receipts'::regclass
   and attname='purchase_intent_id' and attnotnull and not attisdropped and atttypid='uuid'::regtype)
  then raise exception 'enterprise_commission_ledger_drift';end if;
 for r in select * from(values
  ('sales_commission_receipt_attribution','require_sales_commission_sales_assisted',7),
  ('sales_commission_receipt_cutoff_guard','check_sales_commission_departure_cutoff',7),
  ('sales_commission_receipt_week_guard','check_sales_commission_week_unlocked',7),
  ('sales_commission_receipts_immutable','reject_sales_commission_ledger_mutation',27)
 )v(name,fn,kind) loop
  if not exists(select 1 from pg_trigger where tgrelid='public.sales_commission_receipts'::regclass
   and tgname=r.name and tgenabled='O' and tgtype=r.kind and not tgdeferrable
   and tgfoid=to_regprocedure('public.'||r.fn||'()')) then raise exception 'enterprise_commission_trigger_drift';end if;
 end loop;
end $baseline$;

-- Recompile the recognized old expressions, then wrap them unchanged. Dropping
-- NOT NULL never permits a null legacy/Retail intent through a SQL NULL check.
create temporary table enterprise_old_ledger_shape(
 membership_terms_protocol text,membership_contract_id uuid,membership_contract_version integer,
 sales_qualification_id uuid,purchase_intent_id uuid,policy_version text,provider text,
 payment_success_at timestamptz,funds_received_at timestamptz,first_term_start_at timestamptz,first_term_end_at timestamptz,
 gross_membership_cents bigint,discount_cents bigint,provider_fee_cents bigint,
 net_membership_cents bigint generated always as(gross_membership_cents-discount_cents-provider_fee_cents) stored,
 commission_cents bigint generated always as((gross_membership_cents-discount_cents-provider_fee_cents+1)/2) stored,
 constraint sales_commission_receipts_protocol_shape check(
 (membership_terms_protocol='legacy_receipt_v1' and membership_contract_id is null and membership_contract_version is null and sales_qualification_id is null)
 or(membership_terms_protocol='retail_existing_terms_v2' and membership_contract_id is null and membership_contract_version is null
  and sales_qualification_id is not null and sales_qualification_id=purchase_intent_id and policy_version='retail-existing-terms-v2-commission-v1' and provider='stripe')),
 constraint sales_commission_receipts_versioned_payment_window check(
 (membership_terms_protocol='legacy_receipt_v1' and payment_success_at<first_term_end_at)
 or(membership_terms_protocol='retail_existing_terms_v2' and isfinite(payment_success_at) and isfinite(funds_received_at)
  and payment_success_at>=first_term_start_at and payment_success_at<public.retail_existing_month_anchor(first_term_start_at,12)))
) on commit drop;
do $shape$
declare name_ text;old_expr text;expected text;extra text;r record;
begin
 for r in select a.attname,a.atttypid,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) expression
  from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='pg_temp.enterprise_old_ledger_shape'::regclass and a.attgenerated='s' loop
  if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.sales_commission_receipts'::regclass and a.attname=r.attname and a.atttypid=r.atttypid
    and a.attgenerated=r.attgenerated and not a.attisdropped and pg_get_expr(d.adbin,d.adrelid) is not distinct from r.expression)
   then raise exception 'enterprise_commission_generated_amount_drift';end if;
 end loop;
 foreach name_ in array array['sales_commission_receipts_protocol_shape','sales_commission_receipts_versioned_payment_window'] loop
  select pg_get_expr(conbin,conrelid) into old_expr from pg_constraint
   where conrelid='public.sales_commission_receipts'::regclass and conname=name_ and contype='c' and convalidated;
  select pg_get_expr(conbin,conrelid) into expected from pg_constraint
   where conrelid='pg_temp.enterprise_old_ledger_shape'::regclass and conname=name_;
  if old_expr is distinct from expected then raise exception 'enterprise_commission_constraint_drift';end if;
 end loop;
 alter table public.sales_commission_receipts add column enterprise_agreement_id uuid,
  add column enterprise_commission_source jsonb,alter column purchase_intent_id drop not null;
 foreach name_ in array array['sales_commission_receipts_protocol_shape','sales_commission_receipts_versioned_payment_window'] loop
  select pg_get_expr(conbin,conrelid) into old_expr from pg_constraint where conrelid='public.sales_commission_receipts'::regclass and conname=name_;
  extra:=case when name_='sales_commission_receipts_protocol_shape' then
   '(membership_terms_protocol=''enterprise_existing_terms_v1'' and purchase_intent_id is null and enterprise_agreement_id is not null and enterprise_commission_source is not null and jsonb_typeof(enterprise_commission_source)=''object'' and membership_contract_id is null and membership_contract_version is null and sales_qualification_id is null and provider=''stripe'' and policy_version=''enterprise-existing-commission-v1'' and payment_kind in(''monthly'',''paid_in_full''))'
   else '(membership_terms_protocol=''enterprise_existing_terms_v1'' and isfinite(payment_success_at) and isfinite(funds_received_at) and payment_success_at>=first_term_start_at and payment_success_at<public.retail_existing_month_anchor(first_term_start_at,12))' end;
  execute format('alter table public.sales_commission_receipts drop constraint %I',name_);
  execute format('alter table public.sales_commission_receipts add constraint %I check((purchase_intent_id is not null and enterprise_agreement_id is null and enterprise_commission_source is null and (%s)) or %s)',name_,old_expr,extra);
 end loop;
 alter table public.sales_commission_receipts add constraint sales_commission_receipts_enterprise_agreement_fk
  foreign key(enterprise_agreement_id) references public.membership_agreements(id) on delete restrict;
end $shape$;
create index sales_commission_receipts_enterprise_agreement_idx on public.sales_commission_receipts(enterprise_agreement_id)
 where enterprise_agreement_id is not null;

create function public.enterprise_existing_commission_qualification_valid(q jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text;a timestamptz;e timestamptz;
begin
 if not coalesce(public.retail_existing_closed_object(q,array['version','agreement_id','client_id','rep_user_id',
  'billing_source_digest','original_paid_at','original_term_end_at','commission_window_end_at','qualification_closed_at',
  'client_legal_name','original_rep_attested','payment_kind','payroll_authorized']),false)
  or q->>'version' is distinct from 'enterprise_existing_commission_qualification_v1'
  or q->'original_rep_attested' is distinct from 'true'::jsonb or q->'payroll_authorized' is distinct from 'false'::jsonb
  or coalesce(q->>'billing_source_digest','') !~ '^[a-f0-9]{32}$'
  or coalesce(q->>'payment_kind','') not in('monthly','paid_in_full')
  or jsonb_typeof(q->'client_legal_name') is distinct from 'string' or length(btrim(q->>'client_legal_name')) not between 1 and 500
  then return false;end if;
 foreach k in array array['agreement_id','client_id','rep_user_id'] loop
  if jsonb_typeof(q->k) is distinct from 'string' or q->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   then return false;end if;
 end loop;
 foreach k in array array['original_paid_at','original_term_end_at','commission_window_end_at','qualification_closed_at'] loop
  if jsonb_typeof(q->k) is distinct from 'string' or q->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
   or not isfinite((q->>k)::timestamptz) then return false;end if;
 end loop;
 a:=(q->>'original_paid_at')::timestamptz;e:=(q->>'original_term_end_at')::timestamptz;
 return e>a and(q->>'qualification_closed_at')::timestamptz=a
  and(q->>'commission_window_end_at')::timestamptz=public.retail_existing_month_anchor(a,12);
exception when others then return false;
end $$;

-- Read-only native adapter; no coverage refresh or second cash recorder.
create function public.read_enterprise_existing_commission_payment(p_agreement uuid,p_client uuid,p_invoice text,p_rep uuid,p_attested boolean)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;a public.membership_agreements;b public.billing_customers;v public.billing_invoices;
 w jsonb;f jsonb;coverage jsonb;proof jsonb;q jsonb;prior jsonb;rep uuid;key_ text;token_ text;matches_ bigint;
 paid timestamptz;gross bigint;discount bigint;ordinal_ integer;kind text;clock timestamptz;
begin
 if current_user<>'service_role' then raise exception 'enterprise_commission_server_only';end if;
 if p_invoice is null or p_invoice !~ '^in_[A-Za-z0-9_]+$' or length(p_invoice)>200 then raise exception 'enterprise_commission_invoice_required';end if;
 select * into c from public.clients where id=p_client for update;
 if not found or c.parent_client_id is not null or c.archived_at is not null or c.billing_status is distinct from 'active'
  or coalesce(nullif(lower(btrim(c.subscription_status)),''),'active') not in('active','trialing') then raise exception 'enterprise_commission_client_denied';end if;
 select * into a from public.membership_agreements where id=p_agreement for update;
 if not found or a.client_id is distinct from c.id then raise exception 'enterprise_commission_source_denied';end if;
 -- Existing Retail receipt guard uses this bounded NOWAIT census lock too.
 lock table public.membership_agreements,public.billing_invoices in share mode nowait;
 if to_regclass('public.enterprise_existing_usage_batches') is not null then
  lock table public.enterprise_existing_usage_batches in share mode nowait;
 end if;
 lock table public.usage_billing_ledger in share mode nowait;
 coverage:=public.read_enterprise_existing_paid_coverage(a.id,c.id);
 w:=public.read_enterprise_existing_billing(a.id);f:=w->'funding_receipt'->'proof';
 if w is null or coverage->>'billing_source_digest' is distinct from md5(w::text)
  or coverage->>'agreement_id' is distinct from a.id::text or coverage->>'client_id' is distinct from c.id::text
  then raise exception 'enterprise_commission_source_denied';end if;
 select * into strict b from public.billing_customers where stripe_customer_id=c.stripe_customer_id;
 select * into v from public.billing_invoices where stripe_invoice_id=p_invoice for share nowait;
 if found and(v.billing_customer_id is distinct from b.id or v.retail_period_receipt is not null or v.currency is distinct from 'usd')
  then raise exception 'enterprise_commission_invoice_denied';end if;
 if p_invoice=f->>'invoice_id' then
  if v.enterprise_period_receipt is not null then raise exception 'enterprise_commission_invoice_denied';end if;
  proof:=f;gross:=(f->>'platform_line_cents')::bigint;discount:=0;paid:=(f->>'payment_success_at')::timestamptz;ordinal_:=0;
 else
  if v.id is null then raise exception 'enterprise_commission_invoice_denied';end if;
  proof:=v.enterprise_period_receipt->'proof';
  if v.enterprise_period_receipt->>'version' is distinct from 'enterprise_existing_paid_period_receipt_v1'
   or v.enterprise_period_receipt->'source' is distinct from w or v.enterprise_period_receipt->>'source_digest' is distinct from md5(w::text)
   or not coalesce(public.enterprise_existing_period_proof_valid(proof,a),false) or proof->>'invoice_id' is distinct from p_invoice
   then raise exception 'enterprise_commission_invoice_denied';end if;
  gross:=(proof->>'platform_gross_cents')::bigint;discount:=(proof->>'platform_discount_cents')::bigint;
  paid:=(proof->>'paid_at')::timestamptz;ordinal_:=(proof->>'ordinal')::integer;
 end if;
 -- Initial placeholders without native proofs are not extra identities. Count
 -- every actual immutable payment alias globally across the existing cohorts.
 foreach key_ in array array['invoice_id','payment_intent_id','charge_id'] loop
  token_:=proof->>key_;
  if token_ is null then raise exception 'enterprise_commission_identity_denied';end if;
  select count(*) into matches_ from(
   select 1 from public.membership_agreements x where x.enterprise_funding_receipt->'proof'->>key_=token_
   union all select 1 from public.membership_agreements x where
    (case when key_='invoice_id' then x.retail_funding_receipt->'proof'->'period'->>'invoice_id' else x.retail_funding_receipt->'proof'->>key_ end)=token_
   union all select 1 from public.billing_invoices x where x.enterprise_period_receipt->'proof'->>key_=token_
   union all select 1 from public.billing_invoices x where x.retail_period_receipt->'proof'->>key_=token_
  ) identities;
  if matches_<>1 then raise exception 'enterprise_commission_identity_denied';end if;
  if to_regclass('public.enterprise_existing_usage_batches') is not null then
   if exists(select 1 from public.enterprise_existing_usage_batches x where
    (case when key_='invoice_id' then to_jsonb(x)->'provider_operation'->>'invoice_id'
     else to_jsonb(x)->'provider_operation'->'operations'->'pay'->'proof'->>key_ end)=token_)
    then raise exception 'enterprise_commission_usage_denied';end if;
  end if;
 end loop;
 if exists(select 1 from public.usage_billing_ledger where stripe_invoice_id=p_invoice) then raise exception 'enterprise_commission_usage_denied';end if;
 clock:=clock_timestamp();
 if gross<=0 or discount<0 or discount>=gross or not isfinite(paid) or paid>clock
  or paid<(f->>'payment_success_at')::timestamptz
  or paid>=public.retail_existing_month_anchor((f->>'payment_success_at')::timestamptz,12)
  then raise exception 'enterprise_commission_payment_denied';end if;
 -- Root lock serializes first attribution. These rows are append-only, not
 -- current CRM ownership or the creator of an admin-issued agreement.
 if(select count(*) from public.sales_commission_receipts where enterprise_agreement_id=a.id)>1000
  then raise exception 'enterprise_commission_qualification_denied';end if;
 select enterprise_commission_source into prior from public.sales_commission_receipts
  where enterprise_agreement_id=a.id order by reviewed_at,id limit 1;
 if prior is null then
  if p_rep is null or p_attested is distinct from true then raise exception 'enterprise_commission_original_rep_attestation_required';end if;
  rep:=p_rep;
 else
  if not coalesce(public.enterprise_existing_commission_qualification_valid(prior),false)
   or exists(select 1 from public.sales_commission_receipts where enterprise_agreement_id=a.id
    and(enterprise_commission_source is distinct from prior or rep_user_id::text is distinct from prior->>'rep_user_id'))
   then raise exception 'enterprise_commission_qualification_denied';end if;
  rep:=(prior->>'rep_user_id')::uuid;
  if p_rep is not null and p_rep<>rep then raise exception 'enterprise_commission_original_rep_mismatch';end if;
 end if;
 if not exists(select 1 from public.sales_reps r where r.user_id=rep and(r.active or exists(select 1 from public.sales_commission_departures d where d.rep_user_id=rep)))
  then raise exception 'enterprise_commission_rep_denied';end if;
 kind:=case f->>'platform_interval' when 'month' then 'monthly' when 'year' then 'paid_in_full' end;
 q:=jsonb_build_object('version','enterprise_existing_commission_qualification_v1','agreement_id',a.id,'client_id',c.id,'rep_user_id',rep,
  'billing_source_digest',md5(w::text),'original_paid_at',to_char((f->>'payment_success_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'original_term_end_at',w->'client_initial'->>'contract_end_at',
  'commission_window_end_at',to_char(public.retail_existing_month_anchor((f->>'payment_success_at')::timestamptz,12) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'qualification_closed_at',to_char((f->>'payment_success_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'client_legal_name',a.enterprise_checkout_source->'material'->'template_snapshot'->'values'->>'client_legal_name',
  'original_rep_attested',true,'payment_kind',kind,'payroll_authorized',false);
 if not coalesce(public.enterprise_existing_commission_qualification_valid(q),false) or(prior is not null and prior is distinct from q)
  then raise exception 'enterprise_commission_qualification_denied';end if;
 return jsonb_build_object('version','enterprise_existing_commission_payment_v1','qualification',q,
  'provider_payment_id',p_invoice,'gross_membership_cents',gross,'discount_cents',discount,
  'payment_success_at',to_char(paid at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'ordinal',ordinal_,
  'provider_effect_authorized',false,'paid_access_authorized',false,'payroll_authorized',false,'settlement_verified',false);
end $$;

create function public.enterprise_existing_assert_commission_receipt(r jsonb,p_linked boolean)
returns void language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare q jsonb:=r->'enterprise_commission_source';proof jsonb;clock timestamptz:=clock_timestamp();
begin
 if current_user<>'service_role' or p_linked is null or r->>'membership_terms_protocol' is distinct from 'enterprise_existing_terms_v1'
  or not coalesce(public.enterprise_existing_commission_qualification_valid(q),false)
  or r->>'purchase_intent_id' is not null or r->>'membership_contract_id' is not null or r->>'membership_contract_version' is not null
  or r->>'sales_qualification_id' is not null or r->>'enterprise_agreement_id' is distinct from q->>'agreement_id'
  or r->>'rep_user_id' is distinct from q->>'rep_user_id' or r->>'payment_kind' is distinct from q->>'payment_kind'
  or r->>'provider' is distinct from 'stripe' or r->>'policy_version' is distinct from 'enterprise-existing-commission-v1'
  or(r->>'first_term_start_at')::timestamptz is distinct from(q->>'original_paid_at')::timestamptz
  or(r->>'first_term_end_at')::timestamptz is distinct from(q->>'original_term_end_at')::timestamptz
  or(r->>'qualification_closed_at')::timestamptz is distinct from(q->>'qualification_closed_at')::timestamptz
  or(r->>'gross_membership_cents')::bigint is null or(r->>'gross_membership_cents')::bigint<=0
  or(r->>'discount_cents')::bigint is null or(r->>'discount_cents')::bigint<0
  or(r->>'provider_fee_cents')::bigint is null or(r->>'provider_fee_cents')::bigint<0
  or(r->>'gross_membership_cents')::bigint<=(r->>'discount_cents')::bigint+(r->>'provider_fee_cents')::bigint
  or(r->>'funds_received_at')::timestamptz<(r->>'payment_success_at')::timestamptz
  or(r->>'payment_success_at')::timestamptz<(q->>'original_paid_at')::timestamptz
  or(r->>'payment_success_at')::timestamptz>=(q->>'commission_window_end_at')::timestamptz
  or(r->>'payment_success_at')::timestamptz>clock or(r->>'funds_received_at')::timestamptz>clock
  then raise exception 'enterprise_commission_receipt_denied';end if;
 if p_linked then return;end if;
 proof:=public.read_enterprise_existing_commission_payment((q->>'agreement_id')::uuid,(q->>'client_id')::uuid,
  r->>'provider_payment_id',(q->>'rep_user_id')::uuid,(q->>'original_rep_attested')::boolean);
 if proof->'qualification' is distinct from q or(r->>'gross_membership_cents')::bigint is distinct from(proof->>'gross_membership_cents')::bigint
  or(r->>'discount_cents')::bigint is distinct from(proof->>'discount_cents')::bigint
  or(r->>'payment_success_at')::timestamptz is distinct from(proof->>'payment_success_at')::timestamptz
  then raise exception 'enterprise_commission_proof_conflict';end if;
end $$;

do $patch$
declare p record;definition text;body text;injection text;original_oid oid;original_acl aclitem[];original_owner oid;original_config text[];
begin
 select * into p from pg_proc where oid='public.require_sales_commission_sales_assisted()'::regprocedure;
 original_oid:=p.oid;original_acl:=p.proacl;original_owner:=p.proowner;original_config:=p.proconfig;
 if md5(p.prosrc) is distinct from '701caccedf222663e8196af238773e36'
  or(length(p.prosrc)-length(replace(p.prosrc,E'begin\n','')))/length(E'begin\n')<>1
  then raise exception 'enterprise_commission_attribution_patch_drift';end if;
 injection:=$body$
  if tg_table_name='sales_commission_receipts' then v_existing_receipt:=new;
  else select * into v_existing_receipt from public.sales_commission_receipts where id=new.receipt_id;end if;
  if v_existing_receipt.membership_terms_protocol='enterprise_existing_terms_v1' then
    perform public.enterprise_existing_assert_commission_receipt(to_jsonb(v_existing_receipt),tg_table_name<>'sales_commission_receipts');
    return new;
  end if;
$body$;
 definition:=pg_get_functiondef(p.oid);body:=replace(p.prosrc,E'begin\n',E'begin\n'||injection);
 execute replace(definition,p.prosrc,body);
 if not exists(select 1 from pg_proc where oid=original_oid and proacl is not distinct from original_acl
  and proowner=original_owner and proconfig is not distinct from original_config and not prosecdef)
  then raise exception 'enterprise_commission_attribution_metadata_drift';end if;
end $patch$;
revoke all on function public.enterprise_existing_commission_qualification_valid(jsonb),
 public.read_enterprise_existing_commission_payment(uuid,uuid,text,uuid,boolean),
 public.enterprise_existing_assert_commission_receipt(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.enterprise_existing_commission_qualification_valid(jsonb),
 public.read_enterprise_existing_commission_payment(uuid,uuid,text,uuid,boolean),
 public.enterprise_existing_assert_commission_receipt(jsonb,boolean) to service_role;
commit;
