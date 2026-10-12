-- Prospective Enterprise pool source prerequisite only. No checkout executor,
-- signature authentication, Auth ownership, payment or credit release here.
-- Earlier snapshot migration retains marker validation/backfill/paid holds.
begin;

create or replace function public.enterprise_pool_v2_guard_source()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare previous_row jsonb; next_row jsonb; field_name text;
begin
 if coalesce(old.template_snapshot->'values'->'pool_offer_snapshot','null'::jsonb)='null'::jsonb then
  if TG_OP='DELETE' then return old;end if;return new;
 end if;
 if TG_OP='DELETE' then raise exception 'enterprise_pool_v2_source_delete_denied';end if;
 if current_user in('anon','authenticated') then raise exception 'enterprise_pool_v2_server_only';end if;
 previous_row:=to_jsonb(old);next_row:=to_jsonb(new);
 -- Native JSON equality ignores harmless jsonb key order, not changed terms.
 -- Actual signing appends only root execution; every other snapshot key stays.
 if (new.template_snapshot-'execution') is distinct from (old.template_snapshot-'execution') then
  raise exception 'enterprise_pool_v2_source_immutable';
 end if;
 foreach field_name in array array['id','client_id','client_legal_name','dba_trade_name',
  'primary_admin_name','admin_email','membership_tier','initial_term_start','initial_renewal_date',
  'billing_option','auto_renew','notice_deadline_days','template_version','draft_pdf_path',
  'created_by_user_id','created_by_email','created_at','agreement_expires_at'] loop
  if next_row->field_name is distinct from previous_row->field_name then
   raise exception 'enterprise_pool_v2_source_immutable';
  end if;
 end loop;
 -- Keep historical signing artifacts even when current/void/supersession or
 -- checkout bookkeeping changes. Do not rewrite a signed source to a draft.
 if old.signed_at is not null or old.status in('signed','superseded') then
  if new.status not in('signed','superseded','voided') or new.status is null then
   raise exception 'enterprise_pool_v2_signed_source_immutable';
  end if;
  foreach field_name in array array['signed_at','signer_typed_name','signer_accepted',
   'signature_image_path','signature_sha256','signer_ip','signer_user_agent','executed_pdf_path'] loop
   if next_row->field_name is distinct from previous_row->field_name then
    raise exception 'enterprise_pool_v2_signed_source_immutable';
   end if;
  end loop;
  if new.template_snapshot->'execution' is distinct from old.template_snapshot->'execution' then
   raise exception 'enterprise_pool_v2_signed_source_immutable';
  end if;
 end if;return new;
end $$;
drop trigger if exists enterprise_pool_v2_guard_source on public.membership_agreements;
create trigger enterprise_pool_v2_guard_source before update or delete on public.membership_agreements
 for each row execute function public.enterprise_pool_v2_guard_source();

-- The existing table is already NOT NULL. Make the prospective trigger's own
-- pending-state predicate safe against SQL NULL independently of that column.
create or replace function public.enterprise_pool_v2_guard_pending_insert()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if new.offer_snapshot is not null and new.status is distinct from 'pending' then
  raise exception 'enterprise_pool_v2_pending_required';
 end if;return new;
end $$;
drop trigger if exists enterprise_pool_v2_guard_pending_insert on public.client_interview_pools;
create trigger enterprise_pool_v2_guard_pending_insert before insert on public.client_interview_pools
 for each row execute function public.enterprise_pool_v2_guard_pending_insert();

revoke all on function public.enterprise_pool_v2_guard_source(),public.enterprise_pool_v2_guard_pending_insert()
 from public,anon,authenticated;
grant execute on function public.enterprise_pool_v2_guard_source(),public.enterprise_pool_v2_guard_pending_insert() to service_role;
commit;
