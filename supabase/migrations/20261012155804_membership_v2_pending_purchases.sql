-- Inert new-buyer bridge. No contract/Auth/client/provider/payment/access work.
begin;
create table public.membership_v2_pending_purchases(
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 document_id uuid not null unique references public.membership_v2_issued_documents(id) on delete restrict on update restrict,
 source_id uuid not null unique references public.membership_v2_sales_prospects(id) on delete restrict on update restrict,
 scope_id uuid not null unique references public.membership_v2_sales_quote_scopes(id) on delete restrict on update restrict,
 original_salesperson_user_id uuid not null references public.sales_reps(user_id) on delete restrict on update restrict,
 acceptance_attempt_id uuid not null unique references public.membership_v2_document_acceptances(attempt_id) on delete restrict on update restrict,
 environment text not null check(environment in('dev','qa','production')),
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object' and octet_length(source_snapshot::text)<=1048576),
 source_digest text not null check(source_digest=encode(sha256(convert_to(source_snapshot::text,'UTF8')),'hex')),
 created_at timestamptz not null check(isfinite(created_at)),
 expires_at timestamptz not null check(isfinite(expires_at) and expires_at>created_at),
 state text not null default 'awaiting_payment_and_account' check(state='awaiting_payment_and_account'),
 provider_effects_enabled boolean not null default false check(provider_effects_enabled=false),
 account_ownership_verified boolean not null default false check(account_ownership_verified=false),
 activation_enabled boolean not null default false check(activation_enabled=false)
);
alter table public.membership_v2_pending_purchases add constraint membership_v2_pending_acceptance_fk
 foreign key(document_id) references public.membership_v2_document_acceptances(document_id) on delete restrict on update restrict;
alter table public.membership_v2_pending_purchases enable row level security;
alter table public.membership_v2_pending_purchases force row level security;
revoke all on public.membership_v2_pending_purchases from public,anon,authenticated,service_role;
grant select,insert on public.membership_v2_pending_purchases to service_role;
create trigger membership_v2_pending_purchases_immutable before update or delete on public.membership_v2_pending_purchases
 for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_pending_purchases_no_truncate before truncate on public.membership_v2_pending_purchases
 for each statement execute function public.membership_v2_reject_mutation();

-- Native UTC strings make the same immutable descriptor/digest stable across
-- session TimeZone. This is native provenance, NOT inspection of Storage bytes.
create function public.membership_v2_pending_source(p_document uuid,p_token_hash text,p_current boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare d public.membership_v2_issued_documents; a public.membership_v2_document_acceptances;
 p public.membership_v2_signature_pixels; g public.membership_v2_legal_gates;
 s public.membership_v2_sales_prospects; q public.membership_v2_quote_drafts; l public.membership_v2_legal_versions;
 snapshot jsonb; n timestamptz;
begin
 if p_current is null then raise exception 'pending_purchase_source_denied';end if;
 select * into d from public.membership_v2_issued_documents where id=p_document and signer_token_hash=p_token_hash;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 -- Same lock order as native issuer/acceptance. Existence is required; a signed
 -- buyer's immutable original attribution is not reset when a rep is inactive.
 perform 1 from public.sales_reps where user_id=d.issuer_user_id for share;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 perform 1 from public.membership_v2_sales_prospect_heads where scope_id=d.scope_id and current_source_id=d.source_id for update;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 select * into g from public.membership_v2_legal_gates where version=d.legal_version for share;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 n:=clock_timestamp();
 select * into a from public.membership_v2_document_acceptances where document_id=d.id;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 select * into p from public.membership_v2_signature_pixels where document_id=d.id;
 if not found or a.source_id<>d.source_id or a.scope_id<>d.scope_id or a.attempt_id<>p.attempt_id
  or a.signer_token_hash<>d.signer_token_hash or a.source_fingerprint<>d.source_fingerprint
  or a.html_sha256<>d.html_sha256 or a.preview_pdf_sha256<>d.preview_pdf_sha256
  or not a.consent or a.accepted_at<d.issued_at or a.accepted_at>=d.expires_at or a.accepted_at>n
  or p.recorded_at<a.accepted_at or p.recorded_at>n then raise exception 'pending_purchase_source_denied';end if;
 select * into s from public.membership_v2_sales_prospects where id=d.source_id and source_fingerprint=d.source_fingerprint;
 if not found or s.canonical_source::jsonb is distinct from d.source_snapshot or s.scope_id<>d.scope_id
  or s.issuer_user_id<>d.issuer_user_id then raise exception 'pending_purchase_source_denied';end if;
 select * into q from public.membership_v2_quote_drafts where id=s.quote_id and quote_digest=s.quote_digest;
 if not found or q.canonical_quote::jsonb is distinct from d.quote_snapshot or q.scope_id<>d.scope_id
  or q.original_salesperson_user_id<>d.issuer_user_id or q.client_id is not null or q.billing_owner_user_id is not null
  or not public.membership_v2_valid_offer(q.offer_snapshot)
  or not exists(select 1 from public.membership_v2_sales_email_proofs proof
   join public.membership_v2_sales_email_challenges challenge on challenge.source_id=proof.source_id and challenge.token_hash=proof.token_hash
   where proof.source_id=s.id and challenge.source_fingerprint=s.source_fingerprint and proof.method='email_link_v1'
    and proof.verified_at>=challenge.issued_at and proof.verified_at<challenge.expires_at and proof.verified_at<=d.issued_at) then
  raise exception 'pending_purchase_source_denied';end if;
 select * into l from public.membership_v2_legal_versions where version=d.legal_version;
 if not found or l.approved_at>d.issued_at
  or (d.legal_snapshot-'approved_at') is distinct from (to_jsonb(l)-'approved_at')
  or (d.legal_snapshot->>'approved_at')::timestamptz is distinct from l.approved_at then raise exception 'pending_purchase_source_denied';end if;
 if p_current and (g.revoked or exists(select 1 from public.membership_v2_legal_revocations where version=d.legal_version)
  or d.issued_at>n or d.expires_at<=n) then raise exception 'pending_purchase_source_unavailable';end if;
 snapshot:=jsonb_build_object('protocol','retail_pending_purchase_v2','schema_version',2,
  'document',jsonb_build_object('id',d.id,'source_id',d.source_id,'source_fingerprint',d.source_fingerprint,'scope_id',d.scope_id,
   'issuer_user_id',d.issuer_user_id,'legal_version',d.legal_version,'html_sha256',d.html_sha256,
   'preview_pdf_path',d.preview_pdf_path,'preview_pdf_sha256',d.preview_pdf_sha256,'preview_pdf_size',d.preview_pdf_size,
   'issued_at',to_char(d.issued_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'expires_at',to_char(d.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'source',d.source_snapshot,'quote',d.quote_snapshot,'legal',d.legal_snapshot,
  'acceptance',to_jsonb(a)||jsonb_build_object('accepted_at',to_char(a.accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'signature_proof',to_jsonb(p)||jsonb_build_object('recorded_at',to_char(p.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 if octet_length(snapshot::text)>1048576 then raise exception 'pending_purchase_source_denied';end if;
 return jsonb_build_object('snapshot',snapshot,'digest',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),
  'observed_at',to_char(n at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

create function public.membership_v2_guard_pending_purchase()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare context jsonb; d public.membership_v2_issued_documents;
begin
 select * into d from public.membership_v2_issued_documents where id=new.document_id;
 if not found then raise exception 'pending_purchase_source_denied';end if;
 context:=public.membership_v2_pending_source(d.id,d.signer_token_hash,true);
 if new.state is distinct from 'awaiting_payment_and_account' or new.provider_effects_enabled is distinct from false
  or new.account_ownership_verified is distinct from false or new.activation_enabled is distinct from false then
  raise exception 'pending_purchase_inert_required';end if;
 -- Derived descriptors are not request inputs. Omit them entirely; do not
 -- silently accept or overwrite a fabricated quote, owner, timestamp or amount.
 if new.source_id is not null or new.scope_id is not null or new.original_salesperson_user_id is not null
  or new.acceptance_attempt_id is not null or new.source_snapshot is not null or new.source_digest is not null
  or new.created_at is not null or new.expires_at is not null then raise exception 'pending_purchase_derived_fields_denied';end if;
 new.source_id:=d.source_id;new.scope_id:=d.scope_id;new.original_salesperson_user_id:=d.issuer_user_id;
 new.acceptance_attempt_id:=(context->'snapshot'->'acceptance'->>'attempt_id')::uuid;
 new.source_snapshot:=context->'snapshot';new.source_digest:=context->>'digest';
 new.created_at:=(context->>'observed_at')::timestamptz;new.expires_at:=d.expires_at;return new;
end $$;
create trigger membership_v2_guard_pending_purchase before insert on public.membership_v2_pending_purchases
 for each row execute function public.membership_v2_guard_pending_purchase();

create function public.membership_v2_reserve_pending_purchase(p_id uuid,p_document uuid,p_token_hash text,p_environment text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare context jsonb; pending public.membership_v2_pending_purchases;
begin
 if p_id is null or p_id='00000000-0000-0000-0000-000000000000'::uuid or p_environment not in('dev','qa','production') or p_environment is null then
  raise exception 'pending_purchase_denied';end if;
 context:=public.membership_v2_pending_source(p_document,p_token_hash,false);
 select * into pending from public.membership_v2_pending_purchases where document_id=p_document;
 if found then
  if pending.environment is distinct from p_environment or pending.source_snapshot is distinct from context->'snapshot'
   or pending.source_digest is distinct from context->>'digest' then raise exception 'pending_purchase_conflict';end if;
  return jsonb_build_object('action','already_reserved','purchase_id',pending.id);
 end if;
 context:=public.membership_v2_pending_source(p_document,p_token_hash,true);
 insert into public.membership_v2_pending_purchases(id,document_id,environment)
  values(p_id,p_document,p_environment) returning * into pending;
 return jsonb_build_object('action','reserved','purchase_id',pending.id);
end $$;
create function public.membership_v2_read_pending_purchase(p_document uuid,p_token_hash text,p_environment text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare context jsonb; pending public.membership_v2_pending_purchases;
begin
 context:=public.membership_v2_pending_source(p_document,p_token_hash,false);
 select * into pending from public.membership_v2_pending_purchases where document_id=p_document and environment=p_environment;
 if not found then return null;end if;
 if pending.source_snapshot is distinct from context->'snapshot' or pending.source_digest is distinct from context->>'digest' then
  raise exception 'pending_purchase_conflict';end if;
 return jsonb_build_object('purchase',to_jsonb(pending),'context',context,'historical_identity_only',true);
end $$;
revoke all on function public.membership_v2_pending_source(uuid,text,boolean),public.membership_v2_guard_pending_purchase(),
 public.membership_v2_reserve_pending_purchase(uuid,uuid,text,text),public.membership_v2_read_pending_purchase(uuid,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_pending_source(uuid,text,boolean),public.membership_v2_guard_pending_purchase(),
 public.membership_v2_reserve_pending_purchase(uuid,uuid,text,text),public.membership_v2_read_pending_purchase(uuid,text,text) to service_role;
commit;
