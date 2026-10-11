-- billing_model: a stored value is an explicit choice for this client.
--
-- 20261009120000_billing_models stamped every existing row with its tier's
-- model, and until now every plan-settings write did the same, so no row could
-- tell "chosen for this client" apart from "whatever the tier implies". Code no
-- longer writes the column; this clears the values that only repeat the tier.
--
-- A row is cleared only when its billing_model equals the default for its own
-- plan_tier (basic -> fixed, pro -> rollover, enterprise -> usage; 'essential'
-- is basic, as in src/services/billingModel.js). Null then resolves to that
-- same model, so no client changes model today, but a later tier change now
-- moves the client with it. A value that differs from its tier's default, and
-- any row whose tier is not one of the three, is left alone.
--
-- Safe to re-run: a second run finds nothing left to clear. Guarded for a
-- database where the column does not exist yet.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'billing_model'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'plan_tier'
  ) then
    update public.client_plan_settings
    set billing_model = null
    where billing_model is not null
      and billing_model = case lower(trim(coalesce(plan_tier, '')))
        when 'basic' then 'fixed'
        when 'essential' then 'fixed'
        when 'pro' then 'rollover'
        when 'enterprise' then 'usage'
      end;
  end if;
end $$;
