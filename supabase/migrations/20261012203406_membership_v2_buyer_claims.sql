-- Neutral historical buyer identity. No funded access/account creation/legacy
-- mutations. Explicit disabled config; no seed. Tokens/proofs are never stored.
begin;
create schema membership_v2_private;
revoke all on schema membership_v2_private from public,anon,authenticated,service_role;
grant usage on schema membership_v2_private to service_role;
do $$begin
 if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
  raise exception 'buyer_migration_requires_owner';end if;
end $$;
create table public.membership_v2_buyer_contexts (
 id uuid primary key default gen_random_uuid(),
 checkout_context_id uuid not null unique references public.membership_v2_checkout_contexts(id) on update restrict on delete restrict,
 project_url text not null check(project_url ~ '^https://[a-z0-9]{20}\.supabase\.co$'),
 environment text not null check(environment in ('dev','qa','production')),
 claim_enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at))
);
create function public.membership_v2_guard_buyer_context()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if (to_jsonb(new)-'claim_enabled') is distinct from (to_jsonb(old)-'claim_enabled') then
  raise exception 'immutable_buyer_context';end if;return new;
end $$;
create trigger membership_v2_buyer_context_update before update on public.membership_v2_buyer_contexts
 for each row execute function public.membership_v2_guard_buyer_context();
create trigger membership_v2_buyer_context_delete before delete on public.membership_v2_buyer_contexts
 for each row execute function public.membership_v2_reject_mutation();

create table public.membership_v2_buyer_claims (
 claim_id uuid primary key default gen_random_uuid(),
 purchase_id uuid not null unique references public.membership_v2_pending_purchases(id) on update restrict on delete restrict,
 operation_id uuid not null unique references public.membership_v2_paid_invoice_facts(operation_id) on update restrict on delete restrict,
 context_id uuid not null references public.membership_v2_buyer_contexts(id) on update restrict on delete restrict,
 user_id uuid not null references auth.users(id) on update restrict on delete restrict,
 canonical_email text not null,
 source_digest text not null, capture_digest text not null, invoice_digest text not null,
 provider_paid_at bigint not null check(provider_paid_at between 946684800 and 4102444799),
 claimed_at timestamptz not null check(isfinite(claimed_at)),
 access_eligible boolean not null default false check(not access_eligible),
 term_eligible boolean not null default false check(not term_eligible),
 commission_eligible boolean not null default false check(not commission_eligible),
 collection_eligible boolean not null default false check(not collection_eligible)
);
create trigger membership_v2_buyer_claims_immutable before update or delete on public.membership_v2_buyer_claims
 for each row execute function public.membership_v2_reject_mutation();

create function public.membership_v2_buyer_email(v text)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare e text;
begin
 if v is null or length(v)>254 then raise exception 'membership_buyer_claim_held';end if;
 e:=translate(btrim(v,chr(32)||chr(9)||chr(10)||chr(13)||chr(12)||chr(11)),
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
 if e !~ '^[!-~]+@[!-~]+$' or length(e)-length(replace(e,'@',''))<>1 then
  raise exception 'membership_buyer_claim_held';end if;return e;
end $$;
-- This fixed-query owner function genuinely needs Auth row/session locks and
-- private INSERT. No Auth grants, directory lookup, arbitrary SQL, or browser
-- entrypoint. The service is already the trusted private runtime, not a caller
-- supplying its own decoded JWT identity. SDK verification precedes this RPC.
create function membership_v2_private.buyer_claim(p_operation uuid,p_context uuid,p_actor jsonb,p_project text,p_environment text,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o public.membership_v2_checkout_operations; cfg public.membership_v2_buyer_contexts;
 c public.membership_v2_capture_facts; i public.membership_v2_paid_invoice_facts;
 u auth.users; s auth.sessions; n timestamptz; x jsonb; e text; r public.membership_v2_buyer_claims;
begin
 if current_setting('role',true) is distinct from 'service_role' or p_action is null or p_action not in ('context','record','read')
  or not public.membership_v2_fact_keys(p_actor,array['user_id','email','confirmed_at','session_id','expires_epoch'])
  or octet_length(p_actor::text)>1024
  or exists(select 1 from jsonb_each(p_actor) z where z.key<>'expires_epoch' and jsonb_typeof(z.value)<>'string')
  or coalesce(p_actor->>'user_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or coalesce(p_actor->>'session_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or coalesce(p_actor->>'confirmed_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  or not public.membership_v2_fact_epoch(p_actor->'expires_epoch') then raise exception 'membership_buyer_claim_held';end if;
 -- Stable order: per-purchase unique operation mutex, config, user, session.
 -- Unique insertion therefore never waits AFTER the sampled native decision.
 select * into o from public.membership_v2_checkout_operations where id=p_operation for update;
 if not found then raise exception 'membership_buyer_claim_held';end if;
 select * into cfg from public.membership_v2_buyer_contexts where id=p_context for share;
 if not found or not cfg.claim_enabled or cfg.checkout_context_id<>o.context_id
  or cfg.project_url is distinct from p_project or cfg.environment is distinct from p_environment then
  raise exception 'membership_buyer_claim_held';end if;
 select * into u from auth.users where id=(p_actor->>'user_id')::uuid for share;
 if not found then raise exception 'membership_buyer_claim_held';end if;
 select * into s from auth.sessions where id=(p_actor->>'session_id')::uuid and user_id=u.id for share;
 if not found then raise exception 'membership_buyer_claim_held';end if;
 n:=clock_timestamp();
 e:=public.membership_v2_buyer_email(p_actor->>'email');
 if u.is_anonymous is distinct from false or u.deleted_at is not null or u.email_confirmed_at is null
  or not isfinite(u.email_confirmed_at) or u.email_confirmed_at>n
  or u.email_confirmed_at is distinct from (p_actor->>'confirmed_at')::timestamptz
  or (u.banned_until is not null and u.banned_until>n)
  or public.membership_v2_buyer_email(u.email) is distinct from e
  or s.created_at is null or not isfinite(s.created_at) or s.created_at>n
  or (s.not_after is not null and s.not_after<=n)
  or to_timestamp((p_actor->>'expires_epoch')::bigint)<=n then raise exception 'membership_buyer_claim_held';end if;
 x:=public.membership_v2_financial_context(o.id);
 if x->'context'->>'environment' is distinct from cfg.environment
  or public.membership_v2_buyer_email(x->'purchase'->'source_snapshot'->'source'->'buyer'->>'buyer_email') is distinct from e then
  raise exception 'membership_buyer_claim_held';end if;
 select * into c from public.membership_v2_capture_facts where operation_id=o.id;
 if not found then raise exception 'membership_buyer_claim_held';end if;
 select * into i from public.membership_v2_paid_invoice_facts where operation_id=o.id;
 if not found or c.purchase_id<>o.purchase_id or c.source_digest<>o.source_digest or i.source_digest<>o.source_digest
  or c.proof_digest<>encode(pg_catalog.sha256(convert_to(c.proof::text,'UTF8')),'hex')
  or i.proof_digest<>encode(pg_catalog.sha256(convert_to(i.proof::text,'UTF8')),'hex')
  or not public.membership_v2_capture_proof_matches(o.id,c.proof)
  or not public.membership_v2_invoice_proof_matches(o.id,i.proof)
  or to_timestamp(i.provider_paid_at)>n then raise exception 'membership_buyer_claim_held';end if;
 -- Original capture/invoice are historical identity only. Current refunds or
 -- disputes do NOT erase who paid. This deliberately grants NO funded access;
 -- later admission must perform fresh current-risk/remaining-funds checks.
 if p_action='context' then
  return jsonb_build_object('project_url',cfg.project_url,'environment',cfg.environment,'claim_enabled',cfg.claim_enabled);
 end if;
 if p_action='record' then
  insert into public.membership_v2_buyer_claims(purchase_id,operation_id,context_id,user_id,canonical_email,
   source_digest,capture_digest,invoice_digest,provider_paid_at,claimed_at)
   values(o.purchase_id,o.id,cfg.id,u.id,e,o.source_digest,c.proof_digest,i.proof_digest,i.provider_paid_at,n)
   on conflict(operation_id) do nothing;
 end if;
 select * into r from public.membership_v2_buyer_claims where operation_id=o.id;
 if not found or r.purchase_id<>o.purchase_id or r.context_id<>cfg.id or r.user_id<>u.id or r.canonical_email<>e
  or r.source_digest<>o.source_digest or r.capture_digest<>c.proof_digest or r.invoice_digest<>i.proof_digest
  or r.provider_paid_at<>i.provider_paid_at then raise exception 'membership_buyer_claim_held';end if;
 return jsonb_build_object('claim_id',r.claim_id,'operation_id',r.operation_id,'user_id',r.user_id,
  'provider_paid_at',r.provider_paid_at,'access_eligible',r.access_eligible,'term_eligible',r.term_eligible,
  'commission_eligible',r.commission_eligible,'collection_eligible',r.collection_eligible);
exception when others then raise exception 'membership_buyer_claim_held' using errcode='P0001';
end $$;
create function public.membership_v2_record_buyer_claim(p_operation uuid,p_context uuid,p_actor jsonb,p_project text,p_environment text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select membership_v2_private.buyer_claim(p_operation,p_context,p_actor,p_project,p_environment,'record');
$$;
create function public.membership_v2_read_buyer_claim(p_operation uuid,p_context uuid,p_actor jsonb,p_project text,p_environment text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select membership_v2_private.buyer_claim(p_operation,p_context,p_actor,p_project,p_environment,'read');
$$;
create function public.membership_v2_buyer_context(p_operation uuid,p_context uuid,p_actor jsonb,p_project text,p_environment text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select membership_v2_private.buyer_claim(p_operation,p_context,p_actor,p_project,p_environment,'context');
$$;
do $$declare t text;begin
 foreach t in array array['membership_v2_buyer_contexts','membership_v2_buyer_claims'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('create trigger %I before truncate on public.%I for each statement execute function public.membership_v2_reject_mutation()',t||'_no_truncate',t);
 end loop;
end $$;
grant select on public.membership_v2_buyer_contexts to service_role;
revoke all on function membership_v2_private.buyer_claim(uuid,uuid,jsonb,text,text,text),public.membership_v2_guard_buyer_context(),
 public.membership_v2_buyer_email(text),public.membership_v2_record_buyer_claim(uuid,uuid,jsonb,text,text),
 public.membership_v2_read_buyer_claim(uuid,uuid,jsonb,text,text),public.membership_v2_buyer_context(uuid,uuid,jsonb,text,text)
 from public,anon,authenticated,service_role;
grant execute on function membership_v2_private.buyer_claim(uuid,uuid,jsonb,text,text,text),public.membership_v2_record_buyer_claim(uuid,uuid,jsonb,text,text),
 public.membership_v2_read_buyer_claim(uuid,uuid,jsonb,text,text),public.membership_v2_buyer_context(uuid,uuid,jsonb,text,text) to service_role;
commit;
