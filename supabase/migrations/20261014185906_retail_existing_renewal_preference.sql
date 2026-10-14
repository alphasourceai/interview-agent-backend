-- LOCAL candidate. Existing row, audit, grants and RLS; no collection engine.
begin;
set local lock_timeout='10s';
do $baseline$ begin
 if exists(select 1 from pg_attribute where attrelid='public.clients'::regclass
  and attname='retail_renewal_change' and not attisdropped)
  or exists(select 1 from pg_proc where pronamespace='public'::regnamespace
   and proname in('retail_existing_renewal_guard','change_retail_existing_renewal','retail_existing_renewal_projection_valid'))
  then raise exception 'retail_renewal_schema_drift';end if;
 perform public.retail_existing_funding_schema_guard();
end $baseline$;
alter table public.clients add column retail_renewal_change jsonb;

create function public.retail_existing_renewal_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='INSERT' then
  if new.retail_renewal_change is not null then raise exception 'retail_renewal_writer_required';end if;return new;
 end if;
 if new.retail_renewal_change is not distinct from old.retail_renewal_change
  and (old.retail_renewal_change is null or (new.auto_renew is not distinct from old.auto_renew
   and new.cancel_at_term_end is not distinct from old.cancel_at_term_end)) then return new;end if;
 if current_user<>'service_role'
  or current_setting('private_sales.retail_renewal_writer',true) is distinct from new.id::text
  then raise exception 'retail_renewal_writer_required';end if;
 return new;
end $$;
create trigger retail_existing_renewal_guard before insert or update on public.clients
 for each row execute function public.retail_existing_renewal_guard();

create function public.retail_existing_renewal_projection_valid(p jsonb,s jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare b jsonb:=s->'original_period';o jsonb:=s->'package_snapshot'->'membership_terms';
 k text;start_b timestamptz;start_p timestamptz;offset_m integer;span integer;
begin
 if not coalesce(public.retail_existing_closed_object(p,array['subscription_id','customer_id','livemode','price_id',
  'subscription_item_id','unit_amount','interval_count','quantity','currency','billing_cycle_anchor',
  'current_period_start','current_period_end','status','cancel_at_period_end','cancel_at','test_clock']),false)
  or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'
  or p->'livemode' is distinct from b->'livemode' or p->>'currency' is distinct from 'usd'
  or p->'billing_cycle_anchor' is distinct from b->'provider_period_start'
  or p->'unit_amount' is distinct from o->'platform_payment_cents'
  or p->'interval_count' is distinct from o->'stripe_recurrence'->'interval_count' or p->'quantity' is distinct from '1'::jsonb
  or p->>'status' is null or p->>'status' not in('active','past_due','unpaid','canceled')
  or jsonb_typeof(p->'cancel_at_period_end') is distinct from 'boolean'
  or(p->'test_clock'<>'null'::jsonb and (p->'livemode'='true'::jsonb or jsonb_typeof(p->'test_clock')<>'string'))
  then return false;end if;
 foreach k in array array['subscription_id','customer_id','price_id','subscription_item_id'] loop
  if p->k is distinct from b->k then return false;end if;
 end loop;
 foreach k in array array['current_period_start','current_period_end'] loop
  if jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$'
   or(p->>k)::numeric not between 1 and 253402300799 then return false;end if;
 end loop;
 if p->'cancel_at'<>'null'::jsonb and (jsonb_typeof(p->'cancel_at') is distinct from 'number'
  or p->>'cancel_at' !~ '^[0-9]+$' or(p->>'cancel_at')::numeric not between 1 and 253402300799) then return false;end if;
 start_b:=to_timestamp((b->>'provider_period_start')::bigint);start_p:=to_timestamp((p->>'current_period_start')::bigint);
 offset_m:=(extract(year from start_p)::integer-extract(year from start_b)::integer)*12
  +extract(month from start_p)::integer-extract(month from start_b)::integer;
 span:=(o->'stripe_recurrence'->>'interval_count')::integer;
 return offset_m between 0 and 12000 and mod(offset_m,span)=0
  and start_p=public.retail_existing_month_anchor(start_b,offset_m)
  and to_timestamp((p->>'current_period_end')::bigint)=public.retail_existing_month_anchor(start_b,offset_m+span);
exception when others then return false;
end $$;

create function public.change_retail_existing_renewal(p_agreement uuid,p_client uuid,p_source jsonb,p_action text,
 p_auto_renew boolean,p_operation uuid,p_generation integer,p_observation jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare c public.clients;s jsonb;o jsonb;b jsonb;r jsonb;prior jsonb;clock timestamptz;cutoff timestamptz;
 months integer;step integer;status text;fact text;now_text text;operation uuid;generation integer;obs jsonb;matches boolean;
begin
 if current_user<>'service_role' then raise exception 'retail_renewal_server_only';end if;
 if p_action is null or p_action not in('read','request','claim','send','repair','unknown','finish','hold','reject')
  then raise exception 'retail_renewal_action_denied';end if;
 perform 1 from public.public_purchase_intents where agreement_id=p_agreement order by id for update;
 perform 1 from public.membership_agreements where id=p_agreement for update;
 select * into c from public.clients where id=p_client for update;
 perform 1 from public.billing_customers where stripe_customer_id=c.stripe_customer_id order by id for share;
 s:=public.read_retail_existing_recurring_source(p_agreement,p_client);o:=s->'package_snapshot'->'membership_terms';b:=s->'original_period';
 if s is distinct from p_source or o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-14-v2'
  or c.plan_tier is distinct from o->>'plan_key'
  or c.billing_interval is distinct from(case o->>'payment_option' when 'prepaid' then 'prepaid' else 'monthly' end)
  then raise exception 'retail_renewal_source_denied';end if;
 clock:=clock_timestamp();now_text:=to_char(clock at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 r:=c.retail_renewal_change;prior:=r;
 if r is not null and (r->>'version' is distinct from 'retail_existing_renewal_change_v1'
  or r->'source' is distinct from s or r->>'source_digest' is distinct from md5(s::text))
  then raise exception 'retail_renewal_operation_drift';end if;
 if p_action='read' then return jsonb_build_object('status',coalesce(r->>'status','none'),'operation',r);end if;
 if p_action='request' then
  if p_auto_renew is null or p_operation is not null or p_generation is not null or p_observation is not null
   then raise exception 'retail_renewal_request_denied';end if;
  if r is not null and (r->>'status' in('claimed','unknown')
    or(r->>'status'='held' and(r->>'billing_cutoff_at')::timestamptz>clock)
    or(r->>'status'<>'held' and r->'requested_auto_renew'=to_jsonb(p_auto_renew)))
   then return jsonb_build_object('status',r->>'status','operation',r);end if;
  months:=(o->>'commitment_months')::integer;
  step:=greatest(1,((extract(year from clock)::integer-extract(year from to_timestamp((b->>'provider_period_start')::bigint))::integer)*12
   +extract(month from clock)::integer-extract(month from to_timestamp((b->>'provider_period_start')::bigint))::integer)/months);
  cutoff:=public.retail_existing_month_anchor(to_timestamp((b->>'provider_period_start')::bigint),step*months);
  while cutoff<=clock loop step:=step+1;cutoff:=public.retail_existing_month_anchor(to_timestamp((b->>'provider_period_start')::bigint),step*months);end loop;
  if step>1000 then raise exception 'retail_renewal_calendar_denied';end if;
  operation:=gen_random_uuid();
  r:=jsonb_build_object('version','retail_existing_renewal_change_v1','operation_id',operation,'source',s,'source_digest',md5(s::text),
   'requested_auto_renew',p_auto_renew,'billing_cutoff_at',to_char(cutoff at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.000"Z"'),
   'requested_at',now_text,'status','waiting','generation',0,'lease_until',null,'sent_at',null,'observation',null,'completed_at',null);
  fact:='requested';
 else
  if r is null or r->>'operation_id' is distinct from p_operation::text or r->'generation' is distinct from to_jsonb(p_generation)
   or p_auto_renew is not null then raise exception 'retail_renewal_identity_denied';end if;
  status:=r->>'status';operation:=p_operation;generation:=p_generation;
  cutoff:=(r->>'billing_cutoff_at')::timestamptz;
  if status='applied' then return jsonb_build_object('status',status,'operation',r);end if;
  if p_action='hold' then
   -- A preflight observer knows the same generation, not the claimant's SDK
   -- result. Never make a sent/unknown operation terminal or replaceable.
   if status in('claimed','unknown') or r->'sent_at'<>'null'::jsonb then
    return jsonb_build_object('status',case when status='claimed' then 'busy' else status end,'operation',r);end if;
   r:=jsonb_set(r,'{status}','"held"');fact:='held';
  elsif p_action='reject' then
   -- Only a known setting-update rejection, never a read failure. Trusted
   -- adapter supplies the exact dispatch observation under its current claim.
   if status<>'claimed' or r->'sent_at'='null'::jsonb or p_observation is distinct from r->'observation'
    then raise exception 'retail_renewal_rejection_denied';end if;
   r:=jsonb_set(r,'{status}','"held"');fact:='setting-rejected';
  elsif p_action='claim' then
   if status='held' then return jsonb_build_object('status',status,'operation',r);end if;
   if status in('claimed','unknown') and(r->>'lease_until')::timestamptz>clock then
    return jsonb_build_object('status','busy','operation',r);end if;
   matches:=case when r->'requested_auto_renew'='true'::jsonb then
    p_observation->>'status'<>'canceled' and p_observation->'cancel_at_period_end'='false'::jsonb and p_observation->'cancel_at'='null'::jsonb
    else p_observation->'cancel_at_period_end'='true'::jsonb and to_timestamp((p_observation->>'cancel_at')::bigint)=cutoff end;
   if not coalesce(public.retail_existing_renewal_projection_valid(p_observation,s),false)
    or p_observation->'test_clock' is distinct from 'null'::jsonb
    or to_timestamp((p_observation->>'current_period_end')::bigint)<>cutoff
    or(not coalesce(matches,false) and(p_observation->>'status'<>'active' or cutoff<=clock))
    or(p_observation->'cancel_at'<>'null'::jsonb and to_timestamp((p_observation->>'cancel_at')::bigint)<>cutoff)
    then raise exception 'retail_renewal_arm_denied';end if;
   if r->'sent_at'<>'null'::jsonb and ((r->'observation')-'cancel_at'-'cancel_at_period_end'-'status')
    is distinct from(p_observation-'cancel_at'-'cancel_at_period_end'-'status') then raise exception 'retail_renewal_provider_changed';end if;
   r:=r||jsonb_build_object('status','claimed','generation',generation+1,'lease_until',clock+interval '120 seconds','observation',p_observation);
   fact:='claim-'||(generation+1)::text;
  else
   if status<>'claimed' or(r->>'lease_until')::timestamptz<=clock or(p_action<>'finish' and cutoff<=clock)
    then raise exception 'retail_renewal_claim_expired';end if;
   if p_action='unknown' then
    r:=r||jsonb_build_object('status','unknown','lease_until',clock);fact:='unknown-'||generation::text;
   else
    obs:=p_observation;
    if not coalesce(public.retail_existing_renewal_projection_valid(obs,s),false)
     or(p_action<>'finish' and obs->>'status'<>'active') or obs->'test_clock' is distinct from 'null'::jsonb
     or to_timestamp((obs->>'current_period_end')::bigint)<>cutoff
     or(obs-'cancel_at'-'cancel_at_period_end') is distinct from((r->'observation')-'cancel_at'-'cancel_at_period_end')
     then raise exception 'retail_renewal_provider_changed';end if;
    if p_action='finish' then
     if (r->'requested_auto_renew'='true'::jsonb and (obs->>'status'='canceled' or obs->'cancel_at_period_end'<>'false'::jsonb or obs->'cancel_at'<>'null'::jsonb))
      or(r->'requested_auto_renew'='false'::jsonb and(obs->'cancel_at_period_end'<>'true'::jsonb
       or to_timestamp((obs->>'cancel_at')::bigint) is distinct from cutoff)) then raise exception 'retail_renewal_readback_denied';end if;
     r:=r||jsonb_build_object('status','applied','observation',obs,'completed_at',now_text,'lease_until',null);fact:='applied';
    elsif p_action='send' then
     if obs->'cancel_at'<>'null'::jsonb and to_timestamp((obs->>'cancel_at')::bigint)<>cutoff
      then raise exception 'retail_renewal_foreign_cancel';end if;
     if r->'sent_at'='null'::jsonb then r:=jsonb_set(r,'{sent_at}',to_jsonb(now_text));end if;
     fact:='send-'||generation::text;
    elsif p_action='repair' then
     if r->'requested_auto_renew'<>'true'::jsonb or r->'sent_at'='null'::jsonb
      or obs->'cancel_at_period_end'<>'false'::jsonb or to_timestamp((obs->>'cancel_at')::bigint) is distinct from cutoff
      then raise exception 'retail_renewal_repair_denied';end if;
     fact:='repair-'||generation::text;
    else raise exception 'retail_renewal_action_denied';end if;
   end if;
  end if;
 end if;
 perform set_config('private_sales.retail_renewal_writer',c.id::text,true);
 update public.clients set retail_renewal_change=r,
  auto_renew=case when r->>'status'='applied' then(r->>'requested_auto_renew')::boolean else auto_renew end,
  cancel_at_term_end=case when r->>'status'='applied' then not(r->>'requested_auto_renew')::boolean else cancel_at_term_end end
  where id=c.id;
 perform set_config('private_sales.retail_renewal_writer','',true);
 -- Fact-specific identity, not a Stripe event; no receipt, access or contract write.
 insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
  values('retail-renewal:'||operation::text||':'||fact,'retail.renewal.'||fact,true,c.id,
   jsonb_build_object('operation_id',operation,'fact',fact,'requested_auto_renew',r->'requested_auto_renew',
    'billing_cutoff_at',r->'billing_cutoff_at','generation',r->'generation','recorded_at',now_text))
  on conflict(stripe_event_id) do nothing;
 if p_action='request' and prior is not null and prior->>'status'='waiting' then
  insert into public.billing_events(stripe_event_id,type,processed_ok,client_id,payload)
   values('retail-renewal:'||(prior->>'operation_id')||':superseded','retail.renewal.superseded',true,c.id,
    jsonb_build_object('operation_id',prior->'operation_id','replaced_by_operation_id',operation,'recorded_at',now_text))
   on conflict(stripe_event_id) do nothing;
 end if;
 -- An audit-identity wait must not let a setting reservation cross B or its
 -- claim lease. Any failure rolls the row/audit writes back together.
 if p_action in('claim','send','repair') and ((p_action<>'claim' and(r->>'billing_cutoff_at')::timestamptz<=clock_timestamp())
  or(r->>'lease_until')::timestamptz<=clock_timestamp())
  then raise exception 'retail_renewal_claim_expired';end if;
 return jsonb_build_object('status',r->>'status','operation',r);
end $$;
revoke all on function public.retail_existing_renewal_guard(),public.retail_existing_renewal_projection_valid(jsonb,jsonb),
 public.change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.retail_existing_renewal_guard(),public.retail_existing_renewal_projection_valid(jsonb,jsonb),
 public.change_retail_existing_renewal(uuid,uuid,jsonb,text,boolean,uuid,integer,jsonb) to service_role;
commit;
