-- The v4 stress correction remained close but still rendered gingiva's second
-- short-i as “ee.” Fall back from provider IPA to one continuous lowercase
-- sounds-like token, avoiding the segmented v1 alias behavior.

update public.pronunciation_terms
set pronunciation_method = 'alias',
    pronunciation_value = 'jinjivuh',
    version = 5,
    provider_metadata = provider_metadata || '{"qa_correction":"v4_second_short_i_still_rendered_as_ee","provider_format":"continuous_lowercase_alias","owner_reference":"local_only_not_persisted"}'::jsonb,
    updated_at = now()
where canonical_term = 'gingiva'
  and scope_type = 'industry'
  and industry_key = 'dental'
  and pronunciation_method = 'ipa'
  and pronunciation_value = 'dʒ|ˈ|ɪ|n|dʒ|ɪ|v|ə'
  and verification_status = 'verified'
  and is_active
  and version = 4;

do $$
begin
  if (select count(*) from public.pronunciation_terms
      where canonical_term = 'gingiva'
        and scope_type = 'industry' and industry_key = 'dental'
        and pronunciation_method = 'alias'
        and pronunciation_value = 'jinjivuh'
        and verification_status = 'verified' and is_active and version = 5) <> 1 then
    raise exception 'pronunciation_gingiva_continuous_alias_mismatch';
  end if;

  if (select count(*) from public.pronunciation_terms
      where scope_type = 'industry' and industry_key = 'dental'
        and verification_status = 'verified' and is_active) <> 9 then
    raise exception 'pronunciation_gingiva_continuous_alias_verified_count_mismatch';
  end if;
end;
$$;
