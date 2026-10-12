-- LOCAL/unmounted capability reads; no browser DB grants or customer route.
begin;
-- Preview8MiB + attestation2MiB + rebuild headroom2MiB = executed12MiB.
alter table public.membership_v2_document_acceptances drop constraint membership_v2_document_acceptances_executed_pdf_size_check;
alter table public.membership_v2_document_acceptances add constraint membership_v2_document_acceptances_executed_pdf_size_check
  check (executed_pdf_size between 16 and 12582912);
create table public.membership_v2_signature_pixels (
  document_id uuid primary key references public.membership_v2_document_acceptances(document_id) on delete restrict on update restrict,
  attempt_id uuid not null unique,
  encoding text not null default 'png_rgba_v1' check (encoding='png_rgba_v1'),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 1024 and width*height<=1048576),
  pixels_sha256 text not null check (pixels_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null check (isfinite(recorded_at))
);
create function public.membership_v2_guard_signature_pixels()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  -- Only a freshly inserted acceptance in THIS top-level transaction can gain
  -- its first pixel proof. Never upgrade a committed metadata-only acceptance.
  -- Native time also excludes ancient/frozen rows after 32-bit XID wraparound.
  -- An acceptance inserted in a subtransaction fails closed; this RPC does not
  -- use savepoints or exception blocks that create subtransactions.
  if not exists(select 1 from public.membership_v2_document_acceptances
    where document_id=new.document_id and attempt_id=new.attempt_id
      and xmin=pg_current_xact_id()::xid and accepted_at>=transaction_timestamp()) then
    raise exception 'retail_signing_denied'; end if;
  new.recorded_at:=clock_timestamp();return new;
end $$;
create trigger membership_v2_guard_signature_pixels before insert on public.membership_v2_signature_pixels
  for each row execute function public.membership_v2_guard_signature_pixels();
create trigger membership_v2_signature_pixels_immutable before update or delete on public.membership_v2_signature_pixels
  for each row execute function public.membership_v2_reject_mutation();
create trigger membership_v2_signature_pixels_no_truncate before truncate on public.membership_v2_signature_pixels
  for each statement execute function public.membership_v2_reject_mutation();
alter table public.membership_v2_signature_pixels enable row level security;
revoke all on public.membership_v2_signature_pixels from public,anon,authenticated,service_role;
grant select,insert on public.membership_v2_signature_pixels to service_role;

create function public.membership_v2_accept_png_document(p_acceptance jsonb,p_pixels_hash text,p_width integer,p_height integer)
returns setof public.membership_v2_document_acceptances
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.membership_v2_document_acceptances; p public.membership_v2_signature_pixels;
begin
  select * into strict a from public.membership_v2_accept_document(p_acceptance);
  select * into p from public.membership_v2_signature_pixels where document_id=a.document_id;
  if found then
    if p.attempt_id<>a.attempt_id or p.pixels_sha256 is distinct from p_pixels_hash or p.width is distinct from p_width or p.height is distinct from p_height then
      raise exception 'document_acceptance_conflict'; end if;
  else
    if not exists(select 1 from public.membership_v2_document_acceptances
      where document_id=a.document_id and attempt_id=a.attempt_id
        and xmin=pg_current_xact_id()::xid and accepted_at>=transaction_timestamp()) then
      raise exception 'retail_signing_denied'; end if;
    insert into public.membership_v2_signature_pixels(document_id,attempt_id,width,height,pixels_sha256)
      values(a.document_id,a.attempt_id,p_width,p_height,p_pixels_hash);
  end if;
  return next a;
end $$;
create function public.membership_v2_signing_session(p_document uuid,p_token_hash text)
returns table(document jsonb,acceptance jsonb,signature_proof jsonb,state text,observed_at timestamptz)
language plpgsql security invoker set search_path=pg_catalog as $$
declare d public.membership_v2_issued_documents; a public.membership_v2_document_acceptances;
  g public.membership_v2_legal_gates; n timestamptz;
begin
  select * into d from public.membership_v2_issued_documents where id=p_document and signer_token_hash=p_token_hash;
  if not found then raise exception 'retail_signing_denied'; end if;
  select * into a from public.membership_v2_document_acceptances where document_id=d.id;
  if found then return query select to_jsonb(d),to_jsonb(a),(select to_jsonb(p) from public.membership_v2_signature_pixels p where p.document_id=d.id),
    'accepted'::text,clock_timestamp(); return; end if;
  perform 1 from public.sales_reps where user_id=d.issuer_user_id for share;
  if not found then raise exception 'retail_signing_denied'; end if;
  perform 1 from public.membership_v2_sales_prospect_heads h join public.membership_v2_sales_prospects s on s.id=h.current_source_id
    where h.scope_id=d.scope_id and h.current_source_id=d.source_id and s.source_fingerprint=d.source_fingerprint for share of h;
  if not found then raise exception 'retail_signing_denied'; end if;
  -- Re-read history immediately after a waited head lock, before expiry/revocation.
  select * into a from public.membership_v2_document_acceptances where document_id=d.id;
  if found then return query select to_jsonb(d),to_jsonb(a),(select to_jsonb(p) from public.membership_v2_signature_pixels p where p.document_id=d.id),
    'accepted'::text,clock_timestamp(); return; end if;
  select * into g from public.membership_v2_legal_gates where version=d.legal_version for share;
  n:=clock_timestamp();
  if not found or g.revoked or d.issued_at>n or d.expires_at<=n then raise exception 'retail_signing_denied'; end if;
  return query select to_jsonb(d),null::jsonb,null::jsonb,'signable'::text,n;
end $$;
create function public.membership_v2_read_acceptance_attempt(p_document uuid,p_token_hash text,p_attempt uuid)
returns table(acceptance jsonb,signature_proof jsonb)
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if not exists(select 1 from public.membership_v2_issued_documents where id=p_document and signer_token_hash=p_token_hash) then
    raise exception 'retail_signing_denied'; end if;
  return query select to_jsonb(a),(select to_jsonb(p) from public.membership_v2_signature_pixels p where p.document_id=a.document_id)
    from public.membership_v2_document_acceptances a where a.document_id=p_document and a.attempt_id=p_attempt;
end $$;
revoke all on function public.membership_v2_signing_session(uuid,text),public.membership_v2_read_acceptance_attempt(uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_signing_session(uuid,text),public.membership_v2_read_acceptance_attempt(uuid,text,uuid) to service_role;
revoke all on function public.membership_v2_guard_signature_pixels(),public.membership_v2_accept_png_document(jsonb,text,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.membership_v2_guard_signature_pixels(),public.membership_v2_accept_png_document(jsonb,text,integer,integer) to service_role;
commit;
