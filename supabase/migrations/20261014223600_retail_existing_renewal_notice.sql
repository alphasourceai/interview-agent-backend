-- LOCAL pending source/native review. Same contract processor and billing_events
-- audit, not a new delivery store/worker. One automatic attempt per boundary;
-- unknown remains manual review and never permits an automatic resend.
begin;
create function public.retail_existing_renewal_notice(p_agreement uuid,p_client uuid,p_action text,
 p_ack jsonb,p_expected_recipient_sha256 text,p_attempt_identity text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s'
 set statement_timeout='2s' as $$
declare a public.membership_agreements;c public.clients;profile public.billing_customers;s jsonb;o jsonb;r jsonb;
 clock_ timestamptz;cutoff_ timestamptz;months_ integer;step_ integer;email_ text;hash_ text;identity_ text;
 facts_ jsonb;payload_ jsonb;attempt_ public.billing_events;winner_ public.billing_events;n_ bigint;
begin
 if current_user<>'service_role' or current_setting('transaction_isolation')<>'read committed'
  or p_agreement is null or p_client is null or p_action is null or p_action not in('claim','record')
  or p_expected_recipient_sha256 is null or p_expected_recipient_sha256 !~ '^[a-f0-9]{64}$'
  then raise exception 'retail_renewal_notice_input_denied';end if;
 if(p_action='claim' and(p_ack is not null or p_attempt_identity is not null)) or(p_action='record' and(
  p_attempt_identity is null or length(p_attempt_identity)>200 or
  jsonb_typeof(p_ack) is distinct from 'object' or not(p_ack ?& array['outcome','provider_reference'])
  or(select count(*) from jsonb_object_keys(p_ack))<>2 or coalesce(p_ack->>'outcome','') not in('accepted','rejected','unknown')
  or not(p_ack->'provider_reference'='null'::jsonb or(jsonb_typeof(p_ack->'provider_reference')='string'
   and length(p_ack->>'provider_reference') between 1 and 128 and p_ack->>'provider_reference' !~ '[[:space:]<>]'))))
  then raise exception 'retail_renewal_notice_ack_denied';end if;
 -- Same renewal-writer order; no locks span the external mail call. Event
 -- append uniqueness is the claim/result CAS, never SELECT FOR UPDATE there.
 perform 1 from public.public_purchase_intents where agreement_id=p_agreement order by id for update;
 select * into a from public.membership_agreements where id=p_agreement for update;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 if p_action='record' then
  -- Echoed native identity is correlation only, never authority for new facts.
  -- In particular a delayed old acknowledgment cannot select a newer attempt.
  select count(*) into n_ from public.billing_events e where e.client_id=p_client
   and e.type='retail.renewal.notice.attempted' and e.payload->>'agreement_id'=p_agreement::text
   and e.stripe_event_id=p_attempt_identity
   and e.payload->>'recipient_sha256'=p_expected_recipient_sha256
   and not exists(select 1 from public.billing_events ack where ack.stripe_event_id=e.stripe_event_id||':ack');
  if n_<>1 then return jsonb_build_object('status','held','code','notice_attempt_missing_or_ambiguous');end if;
  select * into strict attempt_ from public.billing_events e where e.client_id=p_client
   and e.type='retail.renewal.notice.attempted' and e.payload->>'agreement_id'=p_agreement::text
   and e.stripe_event_id=p_attempt_identity
   and e.payload->>'recipient_sha256'=p_expected_recipient_sha256
   and not exists(select 1 from public.billing_events ack where ack.stripe_event_id=e.stripe_event_id||':ack');
  if attempt_.payload->>'template_version' is distinct from 'retail_existing_renewal_notice_v1'
   or attempt_.payload->>'client_id' is distinct from p_client::text
   or attempt_.stripe_event_id is distinct from 'retail-renewal-notice:'||p_agreement::text||':'
    ||(attempt_.payload->>'billing_cutoff_at')||':attempted'
   or attempt_.processed_ok is distinct from true or attempt_.role_id is not null
   then raise exception 'retail_renewal_notice_attempt_drift';end if;
  payload_:=attempt_.payload||jsonb_build_object('ack',p_ack);
  insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
   values(attempt_.stripe_event_id||':ack','retail.renewal.notice.ack',true,p_client,payload_)
   on conflict(stripe_event_id) do nothing returning * into winner_;
  return jsonb_build_object('status',case when winner_.id is null then 'held' else 'recorded' end);
 end if;
 s:=public.read_retail_existing_recurring_source(p_agreement,p_client);o:=s->'package_snapshot'->'membership_terms';
 if a.client_id is distinct from p_client or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'
  or o->'renewal'->'reminder_days' is distinct from '30'::jsonb or c.billing_status is distinct from 'active'
  or c.subscription_status is distinct from 'active' or c.manual_active_override is true
  or c.auto_renew is distinct from true or c.cancel_at_term_end is distinct from false
  then return jsonb_build_object('status','held','code','notice_owner_ineligible');end if;
 r:=c.retail_renewal_change;
 if r is not null and(r->>'version' is distinct from 'retail_existing_renewal_change_v1'
  or r->'source' is distinct from s or r->>'source_digest' is distinct from md5(s::text)
  or r->>'status' is distinct from 'applied' or r->'requested_auto_renew' is distinct from 'true'::jsonb)
  then return jsonb_build_object('status','held','code','notice_renewal_unconfirmed');end if;
 select * into strict profile from public.billing_customers where stripe_customer_id=c.stripe_customer_id and client_id=p_client;
 email_:=lower(btrim(a.admin_email));
 if email_ is null or email_ is distinct from lower(btrim(profile.primary_contact_email)) or length(email_)>254
  or email_ !~ '^[a-z0-9][a-z0-9.!#$%&''*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  or position('..' in email_)>0 or position('.@' in email_)>0
  then return jsonb_build_object('status','held','code','notice_recipient_ambiguous');end if;
 hash_:=encode(sha256(convert_to(email_,'UTF8')),'hex');
 if hash_<>p_expected_recipient_sha256 then return jsonb_build_object('status','held','code','notice_recipient_changed');end if;
 clock_:=clock_timestamp();months_:=(o->>'commitment_months')::integer;
 if months_ not in(3,6,12) then raise exception 'retail_renewal_notice_term_denied';end if;
 step_:=greatest(1,((extract(year from clock_)::integer-extract(year from to_timestamp((s->'original_period'->>'provider_period_start')::bigint))::integer)*12
  +extract(month from clock_)::integer-extract(month from to_timestamp((s->'original_period'->>'provider_period_start')::bigint))::integer)/months_);
 cutoff_:=public.retail_existing_month_anchor(to_timestamp((s->'original_period'->>'provider_period_start')::bigint),step_*months_);
 while cutoff_<=clock_ loop step_:=step_+1;cutoff_:=public.retail_existing_month_anchor(
  to_timestamp((s->'original_period'->>'provider_period_start')::bigint),step_*months_);end loop;
 if step_>1000 then raise exception 'retail_renewal_notice_calendar_denied';end if;
 if clock_<cutoff_-interval '30 days' then return jsonb_build_object('status','not_due');end if;
 if exists(select 1 from public.billing_events e where e.client_id=p_client and e.type='retail.renewal.notice.attempted'
  and e.payload->>'agreement_id'=p_agreement::text
  and not exists(select 1 from public.billing_events ack where ack.stripe_event_id=e.stripe_event_id||':ack'))
  then return jsonb_build_object('status','held','code','notice_previous_attempt_unknown');end if;
 facts_:=jsonb_build_object('version','retail_existing_renewal_notice_v1','agreement_id',p_agreement,'client_id',p_client,
  'recipient_email',email_,'recipient_sha256',hash_,'billing_cutoff_at',to_char(cutoff_ at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'package_snapshot',s->'package_snapshot','template_version','retail_existing_renewal_notice_v1','source_digest',md5(s::text));
 -- Semantic content hash over native facts + fixed template version, not a
 -- false hash claim about branded HTML assembled later by the existing shell.
 payload_:=facts_||jsonb_build_object('content_facts_sha256',encode(sha256(convert_to(facts_::text,'UTF8')),'hex'));
 identity_:='retail-renewal-notice:'||p_agreement::text||':'||(facts_->>'billing_cutoff_at')||':attempted';
 insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
  values(identity_,'retail.renewal.notice.attempted',true,p_client,payload_)
  on conflict(stripe_event_id) do nothing returning * into winner_;
 if winner_.id is null then return jsonb_build_object('status','already_attempted');end if;
 return jsonb_build_object('status','claimed','attempt_identity',identity_,'facts',payload_);
end $$;
revoke all on function public.retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.retail_existing_renewal_notice(uuid,uuid,text,jsonb,text,text) to service_role;
commit;
