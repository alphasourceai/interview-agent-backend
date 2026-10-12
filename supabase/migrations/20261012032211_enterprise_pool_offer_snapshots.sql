-- Prospective pool offer transport only; no legacy backfill or activation.
alter table public.client_interview_pools add column if not exists offer_snapshot jsonb;
alter table public.client_interview_pools add column if not exists offer_digest text;

create or replace function public.enterprise_pool_v2_valid_offer(s jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare q bigint;u bigint;g bigint;p bigint;d bigint;c bigint;n bigint;k text;
begin
 if jsonb_typeof(s) is distinct from 'object' or(select count(*) from jsonb_object_keys(s))<>9
  or not(s ?& array['offer_version','currency','quantity','unit_price_cents','gross_cents','automatic_discount_percent','automatic_discount_cents','coupon_cents','net_cents'])
  or s->>'offer_version' is distinct from 'enterprise-pool-v2-2026-10-11' or s->>'currency' is distinct from 'usd' then return false;end if;
 foreach k in array array['quantity','unit_price_cents','gross_cents','automatic_discount_percent','automatic_discount_cents','coupon_cents','net_cents'] loop
  if jsonb_typeof(s->k) is distinct from 'number' or s->>k !~ '^[0-9]+$' or (s->>k)::numeric>2147483647 then return false;end if;
 end loop;
 q:=(s->>'quantity')::bigint;u:=(s->>'unit_price_cents')::bigint;g:=(s->>'gross_cents')::bigint;
 p:=(s->>'automatic_discount_percent')::bigint;d:=(s->>'automatic_discount_cents')::bigint;
 c:=(s->>'coupon_cents')::bigint;n:=(s->>'net_cents')::bigint;
 return q>0 and u>0 and p<=10 and g=q*u and d=(g*p+50)/100 and c<=g-d and n=g-d-c;
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;
create or replace function public.enterprise_pool_v2_canonical(s jsonb)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select case when public.enterprise_pool_v2_valid_offer(s) then
 '{"offer_version":"enterprise-pool-v2-2026-10-11","currency":"usd","quantity":'||(s->>'quantity')||',"unit_price_cents":'||(s->>'unit_price_cents')||
 ',"gross_cents":'||(s->>'gross_cents')||',"automatic_discount_percent":'||(s->>'automatic_discount_percent')||',"automatic_discount_cents":'||(s->>'automatic_discount_cents')||
 ',"coupon_cents":'||(s->>'coupon_cents')||',"net_cents":'||(s->>'net_cents')||'}' else null end;
$$;
-- Use the existing pgcrypto extension's installed schema, never broaden search_path.
create or replace function public.enterprise_pool_v2_offer_digest(s jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare ext_schema text;v text;result text;
begin
 v:=public.enterprise_pool_v2_canonical(s);if v is null then return null;end if;
 select n.nspname into strict ext_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
 execute format('select encode(%I.digest($1,''sha256''),''hex'')',ext_schema) into result using v;return result;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='enterprise_pool_v2_snapshot_check' and conrelid='public.client_interview_pools'::regclass) then
  alter table public.client_interview_pools add constraint enterprise_pool_v2_snapshot_check check(
   (offer_snapshot is null and offer_digest is null) or
   (offer_snapshot is not null and offer_digest is not null and public.enterprise_pool_v2_valid_offer(offer_snapshot)
    and offer_digest=public.enterprise_pool_v2_offer_digest(offer_snapshot)
    and quantity_purchased=(offer_snapshot->>'quantity')::integer and unit_price_cents=(offer_snapshot->>'unit_price_cents')::integer
    and discount_pct=(offer_snapshot->>'automatic_discount_percent')::integer and total_cents=(offer_snapshot->>'net_cents')::integer));
 end if;
end $$;
create or replace function public.enterprise_pool_v2_guard_pool()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' then if old.offer_snapshot is not null then raise exception 'enterprise_pool_v2_immutable';end if;return old;end if;
 if TG_OP='UPDATE' then
  if old.offer_snapshot is null and(new.offer_snapshot is not null or new.offer_digest is not null) then raise exception 'enterprise_pool_v2_backfill_denied';end if;
  if old.offer_snapshot is not null and
   (new.id,new.client_id,new.quantity_purchased,new.unit_price_cents,new.discount_pct,new.total_cents,new.offer_snapshot,new.offer_digest,new.created_at)
    is distinct from(old.id,old.client_id,old.quantity_purchased,old.unit_price_cents,old.discount_pct,old.total_cents,old.offer_snapshot,old.offer_digest,old.created_at)
   then raise exception 'enterprise_pool_v2_immutable';end if;
 end if;
 if new.offer_snapshot is not null then
  if current_user in('anon','authenticated') then raise exception 'enterprise_pool_v2_server_only';end if;
  if TG_OP='INSERT' and(new.status<>'pending' or new.paid_at is not null or new.stripe_payment_intent_id is not null) then raise exception 'enterprise_pool_v2_pending_required';end if;
  if new.status in('paid','refunded') or new.paid_at is not null then raise exception 'ENTERPRISE_POOL_V2_PAYMENT_PROOF_REQUIRED';end if;
  if not exists(select 1 from public.clients where id=new.client_id) then raise exception 'enterprise_pool_v2_client_denied';end if;
 end if;return new;
end $$;
drop trigger if exists enterprise_pool_v2_guard_pool on public.client_interview_pools;
create trigger enterprise_pool_v2_guard_pool before insert or update or delete on public.client_interview_pools
 for each row execute function public.enterprise_pool_v2_guard_pool();

-- Freeze prospective quote fields on their actual native agreement, without
-- altering old signed rows, signature/execution metadata or legal templates.
create or replace function public.enterprise_pool_v2_guard_agreement()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v jsonb;s jsonb;h text;oldv jsonb;
begin
 v:=new.template_snapshot->'values';s:=v->'pool_offer_snapshot';h:=v->>'pool_offer_digest';
 if TG_OP='UPDATE' then
  oldv:=old.template_snapshot->'values';
  if coalesce(oldv->'pool_offer_snapshot','null'::jsonb)='null'::jsonb and(coalesce(s,'null'::jsonb)<>'null'::jsonb or h is not null)
   then raise exception 'enterprise_pool_v2_agreement_backfill_denied';end if;
  if coalesce(oldv->'pool_offer_snapshot','null'::jsonb)<>'null'::jsonb and
   (new.client_id,v->'pool_offer_snapshot',v->>'pool_offer_digest',v->>'pool_quantity',v->>'usage_interview_fee_cents',v->>'pool_discount_pct',v->>'pool_total_cents',v->>'membership_tier',v->>'billing_model')
    is distinct from(old.client_id,oldv->'pool_offer_snapshot',oldv->>'pool_offer_digest',oldv->>'pool_quantity',oldv->>'usage_interview_fee_cents',oldv->>'pool_discount_pct',oldv->>'pool_total_cents',oldv->>'membership_tier',oldv->>'billing_model')
   then raise exception 'enterprise_pool_v2_agreement_immutable';end if;
 end if;
 if coalesce(s,'null'::jsonb)='null'::jsonb and h is null then return new;end if;
 if current_user in('anon','authenticated') then raise exception 'enterprise_pool_v2_server_only';end if;
 if TG_OP='INSERT' and new.status is distinct from 'draft' then raise exception 'enterprise_pool_v2_draft_required';end if;
 if not public.enterprise_pool_v2_valid_offer(s) or h is distinct from public.enterprise_pool_v2_offer_digest(s)
  or new.membership_tier is distinct from 'enterprise' or v->>'membership_tier' is distinct from 'enterprise'
  or v->>'billing_model' is distinct from 'usage' or v->>'pool_discount_priced' is distinct from 'true'
  or (v->>'pool_quantity')::numeric is distinct from (s->>'quantity')::numeric
  or (v->>'usage_interview_fee_cents')::numeric is distinct from (s->>'unit_price_cents')::numeric
  or (v->>'pool_discount_pct')::numeric is distinct from (s->>'automatic_discount_percent')::numeric
  or (v->>'pool_total_cents')::numeric is distinct from (s->>'net_cents')::numeric then raise exception 'enterprise_pool_v2_agreement_denied';end if;
 return new;
end $$;
drop trigger if exists enterprise_pool_v2_guard_agreement on public.membership_agreements;
create trigger enterprise_pool_v2_guard_agreement before insert or update on public.membership_agreements
 for each row execute function public.enterprise_pool_v2_guard_agreement();
revoke all on function public.enterprise_pool_v2_valid_offer(jsonb),public.enterprise_pool_v2_canonical(jsonb),public.enterprise_pool_v2_offer_digest(jsonb),
 public.enterprise_pool_v2_guard_pool(),public.enterprise_pool_v2_guard_agreement() from public,anon,authenticated;
grant execute on function public.enterprise_pool_v2_valid_offer(jsonb),public.enterprise_pool_v2_canonical(jsonb),public.enterprise_pool_v2_offer_digest(jsonb),
 public.enterprise_pool_v2_guard_pool(),public.enterprise_pool_v2_guard_agreement() to service_role;
