-- LOCAL ONLY: durable request identity on the existing agreement, not a new
-- contract/Auth/Checkout engine. No provider work, old-row DML or backfill.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record;
begin
  foreach spec slice 1 in array array[
    array['retail_existing_valid_offer(jsonb)','acd2d5e1e15c32bfb20e4d0f3439ffcb'],
    array['retail_existing_package(jsonb)','139a00920503f466304e89ac4bb934bb'],
    array['retail_existing_terms_months(jsonb,jsonb)','f9040629d7954ff583f68622d327ad2b'],
    array['retail_existing_closed_object(jsonb,text[])','db187b3a1816eff7f3c2bac7b739fb60']] loop
    select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
    if not found or p.prosecdef or p.provolatile<>'i' or md5(p.prosrc)<>spec[2]
      or p.proconfig is distinct from (case when spec[1]='retail_existing_closed_object(jsonb,text[])'
        then array['search_path=pg_catalog'] else array['search_path=pg_catalog, public'] end)
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or not has_function_privilege('service_role',p.oid,'EXECUTE') then
      raise exception 'retail_checkout_prerequisite_drift';
    end if;
  end loop;
  if not exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
    and attname='checkout_created_at' and atttypid='timestamptz'::regtype and not attnotnull and not atthasdef and not attisdropped)
    or not exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass
      and attname='replaces_stripe_subscription_id' and atttypid='text'::regtype and not attnotnull and not atthasdef and not attisdropped)
    or exists(select 1 from pg_attribute where attrelid='public.membership_agreements'::regclass and not attisdropped
      and attname in('checkout_embedded','checkout_attempt_source')) then
    raise exception 'retail_checkout_schema_drift';
  end if;
end $baseline$;
alter table public.membership_agreements add column checkout_embedded boolean;
alter table public.membership_agreements add column checkout_attempt_source jsonb;

-- Pure accepted-source correspondence. Native rows are passed by the locked
-- RPC/trigger; JSON from a caller cannot become a substitute agreement/intent.
create function public.retail_existing_checkout_material(a jsonb,i jsonb,customer text)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare s jsonb:=a->'template_snapshot'; v jsonb:=s->'values'; p jsonb:=s->'package_snapshot';
  o jsonb:=p->'membership_terms'; b text; n text; signature_time timestamptz; deadline timestamptz;
  original_intent jsonb; intent_deadline timestamptz;
begin
  if customer is null or customer !~ '^cus_[A-Za-z0-9_]+$' or a->>'client_id' is null
    or p is distinct from public.retail_existing_package(o)
    or a->>'template_version' is distinct from 'membership_agreement_retail_terms_v2'
    or s->>'template_version' is distinct from 'membership_agreement_retail_terms_v2'
    or a->'signer_accepted' is distinct from 'true'::jsonb or a->'auto_renew' is distinct from 'true'::jsonb
    or v->'auto_renew' is distinct from 'true'::jsonb
    or a->>'membership_tier' is distinct from o->>'plan_key' or v->>'membership_tier' is distinct from o->>'plan_key'
    or v->'commitment_months' is distinct from o->'commitment_months'
    or v->>'payment_option' is distinct from o->>'payment_option'
    or v->>'pricing_version' is distinct from o->>'offer_version'
    or v->>'term_start_basis' is distinct from 'successful_payment' then
    raise exception 'retail_checkout_source_mismatch';
  end if;
  b:=case when o->>'payment_option'='prepaid' then 'prepaid' else 'monthly' end;
  if a->>'billing_option' is distinct from b or v->>'billing_option' is distinct from b then
    raise exception 'retail_checkout_source_mismatch';
  end if;
  foreach n in array array['platform_fee','per_role_fee','additional_interview_fee','included_interviews_per_role','max_interview_minutes'] loop
    if jsonb_typeof(v->n) not in('number','string') or coalesce(v->>n,'') !~ '^[0-9]+(\.[0-9]{1,2})?$'
      or (v->>n)::numeric is distinct from(p->>n)::numeric then raise exception 'retail_checkout_source_mismatch';end if;
  end loop;
  if v->'first_role_prepay'->'selected' is distinct from o->'first_role_prepay'->'selected' then
    raise exception 'retail_checkout_source_mismatch';
  end if;
  if (o->'first_role_prepay'->>'selected')::boolean and
    ((v->'first_role_prepay'->>'discounted_credit_amount_cents')::numeric is distinct from(o->'first_role_prepay'->>'amount_cents')::numeric
      or (v->'first_role_prepay'->>'normal_role_fee_cents')::numeric is distinct from(o->>'per_role_fee_cents')::numeric
      or v->'first_role_prepay'->>'credit_type' is distinct from 'first_role_prepay') then
    raise exception 'retail_checkout_source_mismatch';
  end if;
  if s->>'source' in('public_purchase_intent','sales_assisted') then
    perform public.retail_existing_terms_months(a,i);
    if i->>'client_id' is distinct from a->>'client_id' then raise exception 'retail_checkout_source_mismatch';end if;
    intent_deadline:=(i->>'expires_at')::timestamptz;
    if not coalesce(isfinite(intent_deadline),false) then raise exception 'retail_checkout_source_mismatch';end if;
    original_intent:=jsonb_build_object('id',i->'id','agreement_id',i->'agreement_id','client_id',i->'client_id',
      'protocol',i->'protocol','package_snapshot',i->'package_snapshot','promotion_code_id',i->'promotion_code_id',
      'expires_at',to_char(intent_deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    if o->>'payment_option'='prepaid' and coalesce(length(btrim(i->>'promotion_code_id')),0)>0 then
      raise exception 'retail_checkout_discount_denied';
    end if;
  elsif i is not null or s->'purchase_intent' is not null then raise exception 'retail_checkout_source_mismatch';
  end if;
  signature_time:=(a->>'signed_at')::timestamptz; deadline:=(a->>'agreement_expires_at')::timestamptz;
  if not coalesce(isfinite(signature_time),false) or not coalesce(isfinite(deadline),false) then
    raise exception 'retail_checkout_source_mismatch';
  end if;
  if octet_length(s::text)>1048576 then raise exception 'retail_checkout_source_too_large';end if;
  return jsonb_build_object('version','retail_existing_checkout_attempt_v1','agreement_id',a->'id','client_id',a->'client_id',
    'template_version',a->'template_version','template_snapshot',s,'membership_tier',a->'membership_tier',
    'billing_option',a->'billing_option','auto_renew',a->'auto_renew','signer_accepted',a->'signer_accepted',
    'signed_at',to_char(signature_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'agreement_expires_at',to_char(deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'signer_token_hash',a->'signer_token_hash','customer_id',customer,'intent',original_intent);
end $$;

create function public.retail_existing_checkout_config_valid(c jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $$
  select coalesce(public.retail_existing_closed_object(c,array['public_backend_base','public_sign_base'])
    and jsonb_typeof(c->'public_backend_base')='string' and jsonb_typeof(c->'public_sign_base')='string'
    and length(c->>'public_backend_base') between 1 and 2048 and length(c->>'public_sign_base') between 1 and 2048
    and c->>'public_backend_base' ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]+)?$'
    and c->>'public_sign_base' ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]+)?$',false)
$$;

create function public.retail_existing_checkout_attempt_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare c jsonb; i jsonb; material jsonb; config jsonb; clock timestamptz;
begin
  if TG_OP='INSERT' then
    if new.checkout_attempt_source is not null or new.checkout_embedded is not null then
      raise exception 'retail_checkout_claim_required';
    end if;return new;
  end if;
  if TG_OP='DELETE' then
    if old.checkout_attempt_source is not null then raise exception 'retail_checkout_attempt_immutable';end if;
    return old;
  end if;
  if old.checkout_attempt_source is not null then
    -- First trace linking is the service's job. Do not add a current_user
    -- restriction to paid bookkeeping: existing service-only SECURITY DEFINER
    -- completion RPCs execute as their owner, not as service_role.
    if current_user<>'service_role' and old.checkout_session_id is null and new.checkout_session_id is not null then
      raise exception 'retail_checkout_session_server_only';
    end if;
    if (new.checkout_attempt_source,new.checkout_embedded,new.checkout_created_at,new.replaces_stripe_subscription_id)
      is distinct from(old.checkout_attempt_source,old.checkout_embedded,old.checkout_created_at,old.replaces_stripe_subscription_id)
      or jsonb_build_array(new.id,new.client_id,new.template_snapshot,new.template_version,new.membership_tier,new.billing_option,
        new.auto_renew,new.signer_accepted,new.signed_at,new.agreement_expires_at,to_jsonb(new)->'signer_token_hash')
      is distinct from jsonb_build_array(old.id,old.client_id,old.template_snapshot,old.template_version,old.membership_tier,old.billing_option,
        old.auto_renew,old.signer_accepted,old.signed_at,old.agreement_expires_at,to_jsonb(old)->'signer_token_hash') then
      raise exception 'retail_checkout_attempt_immutable';
    end if;
    if old.checkout_session_id is not null and new.checkout_session_id is distinct from old.checkout_session_id then
      raise exception 'retail_checkout_session_immutable';
    end if;
  elsif new.checkout_attempt_source is not null then
    -- A direct table write cannot inject invented request facts or a clock.
    -- The same native derivation applies even outside the dedicated RPC.
    if current_user<>'service_role' then raise exception 'retail_checkout_claim_denied';end if;
    clock:=date_trunc('milliseconds',clock_timestamp());config:=new.checkout_attempt_source->'config';
    if old.checkout_created_at is not null or old.checkout_session_id is not null
      or old.status is distinct from 'signed' or old.is_current is distinct from true
      or old.superseded_by_agreement_id is not null
      or (old.checkout_status is not null and old.checkout_status<>'pending_payment') or old.checkout_paid_at is not null
      or not coalesce(isfinite(old.signed_at),false) or old.signed_at>clock
      or not coalesce(isfinite(old.agreement_expires_at),false) or old.agreement_expires_at-clock<interval '30 minutes'
      or new.checkout_embedded is null or not public.retail_existing_checkout_config_valid(config)
      or (new.replaces_stripe_subscription_id is not null and new.replaces_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$')
      or jsonb_build_array(new.id,new.client_id,new.template_snapshot,new.template_version,new.membership_tier,new.billing_option,
        new.auto_renew,new.signer_accepted,new.signed_at,new.agreement_expires_at,to_jsonb(new)->'signer_token_hash')
      is distinct from jsonb_build_array(old.id,old.client_id,old.template_snapshot,old.template_version,old.membership_tier,old.billing_option,
        old.auto_renew,old.signer_accepted,old.signed_at,old.agreement_expires_at,to_jsonb(old)->'signer_token_hash') then
      raise exception 'retail_checkout_claim_denied';
    end if;
    select to_jsonb(t) into c from public.clients t where id=old.client_id;
    begin
      select to_jsonb(t) into strict i from public.public_purchase_intents t where agreement_id=old.id;
    exception when no_data_found then i:=null;
      when too_many_rows then raise exception 'retail_checkout_intent_ambiguous';end;
    if c is null or c->>'parent_client_id' is not null or c->>'archived_at' is not null
      or (i is not null and (i->>'stripe_checkout_session_id' is not null
        or coalesce(i->>'status','') not in('agreement_pending','checkout_pending')
        or i->>'canceled_at' is not null or not coalesce(isfinite((i->>'expires_at')::timestamptz),false)
        or (i->>'expires_at')::timestamptz-clock<interval '30 minutes')) then raise exception 'retail_checkout_claim_denied';end if;
    material:=public.retail_existing_checkout_material(to_jsonb(old),i,c->>'stripe_customer_id');
    if new.checkout_attempt_source is distinct from material||jsonb_build_object('config',config) then
      raise exception 'retail_checkout_source_mismatch';
    end if;
    new.checkout_created_at:=clock;
  elsif new.checkout_embedded is not null then raise exception 'retail_checkout_claim_required';
  end if;
  return new;
end $$;
create trigger retail_existing_checkout_attempt_guard before insert or update or delete on public.membership_agreements
for each row execute function public.retail_existing_checkout_attempt_guard();

-- Intent -> agreement lock order matches the existing funded writers. Client
-- identity is read, not locked: later native pin/SDK reader must recheck it.
-- Never hold native locks while doing provider work.
create function public.claim_retail_existing_checkout_attempt(p_agreement uuid,p_client uuid,p_expected_template jsonb,
  p_customer text,p_embedded boolean,p_replacement text,p_config jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements; i public.public_purchase_intents; c jsonb;
  material jsonb; clock timestamptz; expiry timestamptz; had_intent boolean;
begin
  if current_user<>'service_role' then raise exception 'retail_checkout_server_only';end if;
  perform set_config('lock_timeout','10s',true);
  begin
    select * into strict i from public.public_purchase_intents where agreement_id=p_agreement for update;had_intent:=true;
  exception when no_data_found then had_intent:=false;
    when too_many_rows then raise exception 'retail_checkout_intent_ambiguous';end;
  select * into a from public.membership_agreements where id=p_agreement for update;
  if not found or a.client_id is distinct from p_client or a.template_snapshot is distinct from p_expected_template
    or a.status is distinct from 'signed' or a.is_current is distinct from true or a.superseded_by_agreement_id is not null
    or (a.checkout_status is not null and a.checkout_status<>'pending_payment') or a.checkout_paid_at is not null or p_embedded is null
    or not public.retail_existing_checkout_config_valid(p_config)
    or (p_replacement is not null and p_replacement !~ '^sub_[A-Za-z0-9_]+$') then
    raise exception 'retail_checkout_claim_denied';
  end if;
  clock:=date_trunc('milliseconds',clock_timestamp());
  if not coalesce(isfinite(a.signed_at),false) or a.signed_at>clock
    or not coalesce(isfinite(a.agreement_expires_at),false) or a.agreement_expires_at<=clock
    or (had_intent and (coalesce(i.status,'') not in('agreement_pending','checkout_pending') or i.canceled_at is not null
      or not coalesce(isfinite(i.expires_at),false) or i.expires_at<=clock)) then
    raise exception 'retail_checkout_claim_denied';
  end if;
  select to_jsonb(t) into c from public.clients t where id=p_client;
  if c is null or c->>'parent_client_id' is not null or c->>'archived_at' is not null
    or c->>'stripe_customer_id' is distinct from p_customer then raise exception 'retail_checkout_customer_changed';end if;
  material:=public.retail_existing_checkout_material(to_jsonb(a),case when had_intent then to_jsonb(i) else null end,p_customer);
  if a.checkout_attempt_source is null then
    if a.checkout_created_at is not null or a.checkout_session_id is not null
      or (had_intent and i.stripe_checkout_session_id is not null) then
      raise exception 'retail_checkout_untracked_attempt';
    end if;
    expiry:=least(a.agreement_expires_at,case when had_intent then i.expires_at end,clock+interval '24 hours'-interval '1 second');
    if expiry-clock<interval '30 minutes' then raise exception 'retail_checkout_window_closed';end if;
    update public.membership_agreements set checkout_created_at=clock,checkout_embedded=p_embedded,
      replaces_stripe_subscription_id=p_replacement,
      checkout_attempt_source=material||jsonb_build_object('config',p_config)
      where id=a.id returning * into a;
    expiry:=least(a.agreement_expires_at,case when had_intent then i.expires_at end,a.checkout_created_at+interval '24 hours'-interval '1 second');
    if expiry-clock_timestamp()<interval '30 minutes' then raise exception 'retail_checkout_window_closed';end if;
  else
    if a.checkout_attempt_source-'config' is distinct from material or a.checkout_embedded is null
      or not coalesce(isfinite(a.checkout_created_at),false) or a.checkout_created_at>clock then
      raise exception 'retail_checkout_attempt_changed';
    end if;
    expiry:=least(a.agreement_expires_at,case when had_intent then i.expires_at end,a.checkout_created_at+interval '24 hours'-interval '1 second');
    if clock>=a.checkout_created_at+interval '24 hours' or expiry-clock<interval '30 minutes' then
      raise exception 'retail_checkout_window_closed';
    end if;
  end if;
  return jsonb_build_object('agreement_id',a.id,'client_id',a.client_id,'source',a.checkout_attempt_source,
    'created_at',to_char(a.checkout_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expires_at',floor(extract(epoch from expiry))::bigint,'embedded',a.checkout_embedded,
    'replacement_id',a.replaces_stripe_subscription_id,'checkout_session_id',a.checkout_session_id);
end $$;

revoke all on function public.retail_existing_checkout_material(jsonb,jsonb,text),public.retail_existing_checkout_config_valid(jsonb),
  public.retail_existing_checkout_attempt_guard(),public.claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.retail_existing_checkout_material(jsonb,jsonb,text),public.retail_existing_checkout_config_valid(jsonb),
  public.retail_existing_checkout_attempt_guard(),public.claim_retail_existing_checkout_attempt(uuid,uuid,jsonb,text,boolean,text,jsonb)
  to service_role;
commit;
