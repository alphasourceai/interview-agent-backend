do $$
begin
  if to_regprocedure('public.claim_first_role_prepay_credit(uuid, uuid, text)') is not null then
    revoke execute on function public.claim_first_role_prepay_credit(uuid, uuid, text) from PUBLIC;
    revoke execute on function public.claim_first_role_prepay_credit(uuid, uuid, text) from anon;
    revoke execute on function public.claim_first_role_prepay_credit(uuid, uuid, text) from authenticated;
    grant execute on function public.claim_first_role_prepay_credit(uuid, uuid, text) to service_role;
  end if;
end $$;
