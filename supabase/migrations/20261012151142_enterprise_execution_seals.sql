-- Prospective marked Enterprise signing only. No old signed artifact backfill.
begin;
create or replace function public.enterprise_v2_source_state(snapshot jsonb,tier text)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select case when snapshot->'values'->'pool_offer_snapshot' is null or snapshot->'values'->'pool_offer_snapshot'='null'::jsonb then 'unmarked'
  when tier='enterprise' and jsonb_typeof(snapshot->'values'->'pool_offer_snapshot')='object' then 'marked' else 'malformed' end
$$;
create or replace function public.enterprise_v2_execution_clock(p_agreement uuid,p_token_hash text)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 select * into a from public.membership_agreements where id=p_agreement;
 if not found or public.enterprise_v2_source_state(a.template_snapshot,a.membership_tier)<>'marked'
  or a.status is distinct from 'sent' or a.signed_at is not null or a.signer_token_hash is distinct from p_token_hash
  or a.signer_token_expires_at is null or a.signer_token_expires_at<=clock_timestamp()
  or a.agreement_expires_at is null or a.agreement_expires_at<=clock_timestamp() then raise exception 'enterprise_execution_denied';end if;
 return to_char(date_trunc('milliseconds',clock_timestamp()) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
end $$;
create or replace function public.enterprise_v2_classify_signing_source(p_agreement uuid,p_token_hash text)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements;
begin
 select * into a from public.membership_agreements where id=p_agreement;
 if not found or a.signer_token_hash is distinct from p_token_hash then raise exception 'enterprise_execution_denied';end if;
 return public.enterprise_v2_source_state(a.template_snapshot,a.membership_tier);
end $$;
create table if not exists public.enterprise_v2_execution_seals(
 agreement_id uuid primary key references public.membership_agreements(id) on delete restrict,
 attempt_id uuid not null unique check(attempt_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object' and octet_length(source_snapshot::text)<=1048576),
 execution jsonb not null check(jsonb_typeof(execution)='object'),
 signed_at timestamptz not null,
 recorded_at timestamptz not null default clock_timestamp()
);
alter table public.enterprise_v2_execution_seals enable row level security;
revoke all on public.enterprise_v2_execution_seals from public,anon,authenticated,service_role;
grant select,insert on public.enterprise_v2_execution_seals to service_role;

create or replace function public.enterprise_v2_execution_seal_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements; e jsonb; parent uuid; prepared timestamptz; prefix text;
begin
 if TG_OP<>'INSERT' then raise exception 'enterprise_execution_immutable';end if;
 if current_user in('anon','authenticated') then raise exception 'enterprise_execution_denied';end if;
 -- No storage/network work inside these locks. Serialize sibling prospective
 -- signs before locking an agreement or superseding its previous current row.
 select client_id into parent from public.membership_agreements where id=new.agreement_id;
 if parent is not null then
  perform 1 from public.clients where id=parent for update;
  if not found then raise exception 'enterprise_execution_denied';end if;
 end if;
 select * into a from public.membership_agreements where id=new.agreement_id for update;
 if not found or a.client_id is distinct from parent or a.membership_tier<>'enterprise'
  or public.enterprise_v2_source_state(a.template_snapshot,a.membership_tier)<>'marked'
  or a.status is distinct from 'sent' or a.signed_at is not null
  or a.signer_token_hash is distinct from new.token_hash
  or a.signer_token_expires_at is null or a.signer_token_expires_at<=clock_timestamp()
  or a.agreement_expires_at is null or a.agreement_expires_at<=clock_timestamp()
  or new.source_snapshot is distinct from (a.template_snapshot-'execution') then
  raise exception 'enterprise_execution_denied';
 end if;
 e:=new.execution;
 if (select count(*) from jsonb_object_keys(e))<>17
  or not (e ?& array['version','attempt_id','signed_at','signer_typed_name','signer_accepted',
    'signature_sha256','signature_size','signature_image_path','pixels_sha256','width','height',
    'executed_pdf_path','executed_pdf_sha256','executed_pdf_size','signer_ip','signer_user_agent','encoding'])
  or e->>'version' is distinct from 'enterprise_execution_v2'
  or e->>'attempt_id' is distinct from new.attempt_id::text
  or e->'signer_accepted' is distinct from 'true'::jsonb
  or e->>'encoding' is distinct from 'png_rgba_v1'
  or jsonb_typeof(e->'signer_typed_name') is distinct from 'string'
  or length(btrim(e->>'signer_typed_name')) not between 1 and 160
  or e->>'signer_typed_name' is distinct from btrim(e->>'signer_typed_name')
  or (e->>'signer_typed_name') ~ '[[:cntrl:]<>]'
  or not (coalesce(e->>'signature_sha256','') ~ '^[0-9a-f]{64}$')
  or not (coalesce(e->>'executed_pdf_sha256','') ~ '^[0-9a-f]{64}$')
  or not (coalesce(e->>'pixels_sha256','') ~ '^[0-9a-f]{64}$')
  or jsonb_typeof(e->'signed_at') is distinct from 'string'
  or jsonb_typeof(e->'signature_size') is distinct from 'number'
  or jsonb_typeof(e->'executed_pdf_size') is distinct from 'number'
  or jsonb_typeof(e->'width') is distinct from 'number'
  or jsonb_typeof(e->'height') is distinct from 'number'
  or not (coalesce(e->>'signature_size','') ~ '^[0-9]+$')
  or not (coalesce(e->>'executed_pdf_size','') ~ '^[0-9]+$')
  or not (coalesce(e->>'width','') ~ '^[0-9]+$')
  or not (coalesce(e->>'height','') ~ '^[0-9]+$') then
  raise exception 'enterprise_execution_denied';
 end if;
 if (e->>'signature_size')::numeric not between 57 and 2097152
  or (e->>'executed_pdf_size')::numeric not between 16 and 12582912
  or (e->>'width')::numeric not between 1 and 2048
  or (e->>'height')::numeric not between 1 and 1024
  or (e->>'width')::numeric*(e->>'height')::numeric>1048576
  or (jsonb_typeof(e->'signer_ip')<>'null' and (jsonb_typeof(e->'signer_ip')<>'string' or length(e->>'signer_ip')>128))
  or (jsonb_typeof(e->'signer_user_agent')<>'null' and (jsonb_typeof(e->'signer_user_agent')<>'string' or length(e->>'signer_user_agent')>1024)) then
  raise exception 'enterprise_execution_denied';
 end if;
 begin prepared:=(e->>'signed_at')::timestamptz;
 exception when others then raise exception 'enterprise_execution_denied';end;
 new.recorded_at:=clock_timestamp();new.signed_at:=prepared;
 if not isfinite(prepared) or prepared>new.recorded_at or prepared<new.recorded_at-interval '5 minutes' then
  raise exception 'enterprise_execution_denied';
 end if;
 prefix:='enterprise-v2/'||a.id::text||'/attempts/'||new.attempt_id::text||'/';
 if e->>'signature_image_path' is distinct from prefix||'signature.png'
  or e->>'executed_pdf_path' is distinct from prefix||'executed.pdf' then
  raise exception 'enterprise_execution_denied';
 end if;
 return new;
end $$;

create or replace function public.enterprise_v2_execution_sign()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_agreements; e jsonb;
begin
 e:=new.execution;
 perform 1 from public.complete_membership_agreement_signing(new.agreement_id,(e->>'signed_at')::timestamptz,
  (e->>'signed_at')::timestamptz,e->>'signer_typed_name',e->>'signature_image_path',e->>'signature_sha256',
  e->>'signer_ip',e->>'signer_user_agent',e->>'executed_pdf_path',new.source_snapshot||jsonb_build_object('execution',e));
 select * into a from public.membership_agreements where id=new.agreement_id;
 if a.status is distinct from 'signed' or a.is_current is distinct from true
  or a.signed_at is distinct from (e->>'signed_at')::timestamptz
  or a.template_snapshot->'execution' is distinct from e then raise exception 'enterprise_execution_unverified';end if;
 return new;
end $$;

-- The AFTER INSERT row is now visible to this guard. Thus old RPC/direct
-- updates cannot sign a new marked source without the same native seal.
create or replace function public.enterprise_v2_signing_requires_seal()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare e jsonb; s public.enterprise_v2_execution_seals;
begin
 if old.signed_at is not null or old.status in('signed','superseded') then return new;end if;
 if public.enterprise_v2_source_state(old.template_snapshot,old.membership_tier)='unmarked' then return new;end if;
 if new.signed_at is not null or new.status in('signed','superseded') then
  if public.enterprise_v2_source_state(old.template_snapshot,old.membership_tier)<>'marked' then raise exception 'enterprise_execution_denied';end if;
  select * into s from public.enterprise_v2_execution_seals where agreement_id=old.id;e:=s.execution;
  if not found or s.token_hash is distinct from old.signer_token_hash
   or s.source_snapshot is distinct from old.template_snapshot-'execution'
   or new.template_snapshot-'execution' is distinct from old.template_snapshot-'execution'
   or new.signer_token_hash is distinct from old.signer_token_hash
   or new.status is distinct from 'signed' or new.is_current is distinct from true
   or new.signer_accepted is distinct from true or new.template_snapshot->'execution' is distinct from e
   or new.signed_at is distinct from (e->>'signed_at')::timestamptz
   or new.signer_typed_name is distinct from e->>'signer_typed_name'
   or new.signature_image_path is distinct from e->>'signature_image_path'
   or new.signature_sha256 is distinct from e->>'signature_sha256'
   or new.executed_pdf_path is distinct from e->>'executed_pdf_path'
   or new.signer_ip is distinct from e->>'signer_ip'
   or new.signer_user_agent is distinct from e->>'signer_user_agent' then
   raise exception 'enterprise_execution_seal_required';
  end if;
 end if;return new;
end $$;
drop trigger if exists enterprise_v2_execution_seal_guard on public.enterprise_v2_execution_seals;
create trigger enterprise_v2_execution_seal_guard before insert or update or delete on public.enterprise_v2_execution_seals
 for each row execute function public.enterprise_v2_execution_seal_guard();
drop trigger if exists enterprise_v2_execution_sign on public.enterprise_v2_execution_seals;
create trigger enterprise_v2_execution_sign after insert on public.enterprise_v2_execution_seals
 for each row execute function public.enterprise_v2_execution_sign();
drop trigger if exists enterprise_v2_signing_requires_seal on public.membership_agreements;
create trigger enterprise_v2_signing_requires_seal before update on public.membership_agreements
 for each row execute function public.enterprise_v2_signing_requires_seal();
revoke all on function public.enterprise_v2_source_state(jsonb,text),public.enterprise_v2_execution_clock(uuid,text),public.enterprise_v2_classify_signing_source(uuid,text),
 public.enterprise_v2_execution_seal_guard(),public.enterprise_v2_execution_sign(),public.enterprise_v2_signing_requires_seal()
 from public,anon,authenticated;
grant execute on function public.enterprise_v2_source_state(jsonb,text),public.enterprise_v2_execution_clock(uuid,text),public.enterprise_v2_classify_signing_source(uuid,text),
 public.enterprise_v2_execution_seal_guard(),public.enterprise_v2_execution_sign(),public.enterprise_v2_signing_requires_seal() to service_role;

-- Preserve the legacy RPC signature/row/result while standardizing lock order.
-- NULL-client prospects never supersede another NULL-client agreement.
create or replace function public.complete_membership_agreement_signing(
 p_agreement_id uuid,p_signed_at timestamptz,p_opened_at timestamptz,p_signer_typed_name text,
 p_signature_image_path text,p_signature_sha256 text,p_signer_ip text,p_signer_user_agent text,
 p_executed_pdf_path text,p_template_snapshot jsonb
) returns table(id uuid,client_id uuid,status text,signed_at timestamptz,signer_typed_name text,
 client_legal_name text,primary_admin_name text,admin_email text,executed_pdf_path text,is_current boolean)
language plpgsql security invoker set search_path=pg_catalog as $$
declare v_client_id uuid; locked_client uuid;
begin
 select ma.client_id into v_client_id from public.membership_agreements ma where ma.id=p_agreement_id and ma.status='sent';
 if not found then return;end if;
 if v_client_id is not null then
  perform 1 from public.clients where clients.id=v_client_id for update;
  if not found then raise exception 'membership_signing_parent_missing';end if;
 end if;
 select ma.client_id into locked_client from public.membership_agreements ma where ma.id=p_agreement_id and ma.status='sent' for update;
 if not found then return;end if;
 if locked_client is distinct from v_client_id then raise exception 'membership_signing_parent_changed';end if;
 if v_client_id is not null then
  update public.membership_agreements ma set is_current=false,status=case when ma.status='signed' then 'superseded' else ma.status end,
   superseded_at=p_signed_at,superseded_by_agreement_id=p_agreement_id,updated_at=p_signed_at
  where ma.client_id=v_client_id and ma.is_current=true and ma.id<>p_agreement_id;
 end if;
 return query update public.membership_agreements ma set status='signed',opened_at=coalesce(ma.opened_at,p_opened_at),
  signed_at=p_signed_at,signer_typed_name=p_signer_typed_name,signer_accepted=true,signature_image_path=p_signature_image_path,
  signature_sha256=p_signature_sha256,signer_ip=p_signer_ip,signer_user_agent=p_signer_user_agent,executed_pdf_path=p_executed_pdf_path,
  template_snapshot=p_template_snapshot,updated_at=p_signed_at,is_current=true,superseded_at=null,superseded_by_agreement_id=null
 where ma.id=p_agreement_id and ma.status='sent'
 returning ma.id,ma.client_id,ma.status,ma.signed_at,ma.signer_typed_name,ma.client_legal_name,ma.primary_admin_name,ma.admin_email,ma.executed_pdf_path,ma.is_current;
end $$;
commit;
