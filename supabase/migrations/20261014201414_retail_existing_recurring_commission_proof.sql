-- LOCAL candidate, EXCLUDED from the reviewed release manifest until native
-- tests/exact-source review. Only the existing manual receipt guard changes.
-- No settlement inference, commission automation, new store or legacy rewrite.
begin;
set local lock_timeout='10s';
do $patch$
declare meta record;reader record;definition text;body text;owner_ oid;acl_ aclitem[];config_ text[];
 needle text:=E'  c public.clients; months integer;';injection text;
begin
 select * into meta from pg_proc where oid='public.retail_existing_assert_commission_receipt(jsonb,boolean)'::regprocedure;
 select * into reader from pg_proc where oid='public.read_retail_existing_recurring_source(uuid,uuid)'::regprocedure;
 if md5(meta.prosrc) is distinct from 'da301bac0a531dbcb7ee5f86c9ae70d8'
  or md5(reader.prosrc) is distinct from '0188a99698f4b805a7ade4aff6ac7a84'
  or meta.prosecdef or reader.prosecdef or meta.proconfig is distinct from array['search_path=pg_catalog']
  or reader.proconfig is distinct from array['search_path=pg_catalog','lock_timeout=10s']
  or meta.proowner is distinct from(select oid from pg_roles where rolname='postgres')
  or not has_function_privilege('service_role',meta.oid,'EXECUTE')
  or has_function_privilege('anon',meta.oid,'EXECUTE') or has_function_privilege('authenticated',meta.oid,'EXECUTE')
  or exists(select 1 from aclexplode(coalesce(meta.proacl,acldefault('f',meta.proowner)))
    where grantee not in(meta.proowner,(select oid from pg_roles where rolname='service_role')))
  then raise exception 'native_commission_prerequisite_drift';end if;
 if exists(select 1 from public.sales_commission_receipts r
  join public.public_purchase_intents i on i.id=r.purchase_intent_id
  join public.membership_agreements a on a.id=i.agreement_id
  where i.package_snapshot->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-14-v2'
   or a.template_snapshot->'package_snapshot'->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-14-v2')
  then raise exception 'native_commission_existing_cohort_review_required';end if;
 owner_:=meta.proowner;acl_:=meta.proacl;config_:=meta.proconfig;
 definition:=pg_get_functiondef(meta.oid);body:=meta.prosrc;
 if(length(body)-length(replace(body,needle,'')))/length(needle)<>1
  or body !~ E'\nend[[:space:]]*$' then raise exception 'native_commission_patch_drift';end if;
 body:=replace(body,needle,needle||E'\n  s jsonb;w jsonb;p jsonb;owner_profile uuid;lookup text;key_ text;token_ text;matches_ bigint;ordinal_ integer;span_ integer;');
 injection:=$insert$
  -- Linked correction/payout already returned above. Only NEW native-Stripe
  -- offer receipts require this payment admission; all old manual rules stay.
  if i.package_snapshot->'membership_terms'->>'offer_version'='retail-stripe-terms-2026-10-14-v2' then
    -- Make the global proof census atomic with receipt admission. Existing
    -- append-only proof rows alone cannot exclude a foreign-owner phantom.
    -- NOWAIT refuses concurrent financial work rather than creating a broad
    -- wait/deadlock cycle; the entire existing receipt insert rolls back.
    lock table public.membership_agreements,public.billing_invoices in share mode nowait;
    s:=public.read_retail_existing_recurring_source(q.agreement_id,q.client_id);
    if s->>'source_intent_id' is distinct from q.purchase_intent_id::text
      then raise exception 'native_commission_proof_unavailable';end if;
    lookup:=p_receipt->>'provider_payment_id';
    if lookup is null or lookup !~ '^in_[A-Za-z0-9_]+$' or length(lookup)>200
      then raise exception 'native_commission_invoice_identity_required';end if;
    select id into strict owner_profile from public.billing_customers
      where client_id=q.client_id and stripe_customer_id=s->'original_period'->>'customer_id';
    perform 1 from public.billing_invoices where stripe_invoice_id=lookup order by id for share nowait;
    if lookup=s->'original_period'->>'invoice_id' then
      w:=a.retail_funding_receipt;
      if w->>'version' is distinct from 'retail_existing_funding_v1'
        or w->'proof'->'period' is distinct from s->'original_period'
        then raise exception 'native_commission_proof_unavailable';end if;
      p:=w->'proof'||jsonb_build_object('invoice_id',s->'original_period'->>'invoice_id',
        'ordinal',0,'paid_at',s->'original_period'->>'paid_at');ordinal_:=0;
      if exists(select 1 from public.billing_invoices where stripe_invoice_id=lookup
        and(billing_customer_id<>owner_profile or retail_period_receipt is not null))
        then raise exception 'native_commission_foreign_invoice';end if;
    else
      if(select count(*) from public.billing_invoices where stripe_invoice_id=lookup and billing_customer_id=owner_profile)<>1
        then raise exception 'native_commission_proof_unavailable';end if;
      select retail_period_receipt into strict w from public.billing_invoices
        where stripe_invoice_id=lookup and billing_customer_id=owner_profile;
      if w is null or w->>'version' is distinct from 'retail_existing_paid_period_receipt_v1'
        or w->'source' is distinct from s or not coalesce(public.retail_existing_period_proof_valid(w->'proof',s),false)
        or w->'proof'->>'invoice_id' is distinct from lookup
        then raise exception 'native_commission_proof_unavailable';end if;
      p:=w->'proof';ordinal_:=(p->>'ordinal')::integer;
    end if;
    -- Global proof identity, not a prefix or a particular customer's alias.
    -- Null PI/charge on zero invoices are not identities and are never counted.
    foreach key_ in array array['invoice_id','payment_intent_id','charge_id'] loop
      token_:=p->>key_;
      if token_ is null then continue;end if;
      select count(*) into matches_ from(
        select 1 from public.membership_agreements x where x.retail_funding_receipt is not null
          and(case when key_='invoice_id' then x.retail_funding_receipt->'proof'->'period'->>'invoice_id'
            else x.retail_funding_receipt->'proof'->>key_ end)=token_
        union all
        select 1 from public.billing_invoices v where v.retail_period_receipt is not null
          and v.retail_period_receipt->'proof'->>key_=token_
      ) identities;
      if matches_<>1 then raise exception 'native_commission_proof_identity_ambiguous';end if;
    end loop;
    if(p_receipt->>'gross_membership_cents')::bigint is distinct from(p->>'platform_gross_cents')::bigint
      or(p_receipt->>'discount_cents')::bigint is distinct from(p->>'platform_discount_cents')::bigint
      or(p_receipt->>'payment_success_at')::timestamptz is distinct from(p->>'paid_at')::timestamptz
      then raise exception 'native_commission_proof_conflict';end if;
    span_:=(i.package_snapshot->'membership_terms'->'stripe_recurrence'->>'interval_count')::integer;
    if ordinal_*span_>=12 then raise exception 'outside_original_first_year';end if;
    -- provider_fee_cents / funds_received_at still require ADMIN bank evidence,
    -- all existing future-date/order/fee/weekly/departure checks remain intact.
  end if;
$insert$;
 body:=regexp_replace(body,E'\nend[[:space:]]*$',injection||E'\nend ');
 definition:=replace(definition,meta.prosrc,body);
 if strpos(definition,'native_commission_invoice_identity_required')=0 then raise exception 'native_commission_patch_drift';end if;
 execute definition;
 select * into meta from pg_proc where oid=meta.oid;
 if meta.proowner is distinct from owner_ or meta.proacl is distinct from acl_ or meta.proconfig is distinct from config_
  or meta.prosecdef then raise exception 'native_commission_guard_metadata_drift';end if;
end $patch$;
commit;
