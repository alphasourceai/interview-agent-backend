-- Human listening passed the v3 orthodontics and prophylaxis rules, but the
-- v3 gingiva rule still rendered its second short-i as “ee.” Cartesia requires
-- stress markers directly before the vowel, so correct that placement only.

update public.pronunciation_terms
set pronunciation_value = 'dʒ|ˈ|ɪ|n|dʒ|ɪ|v|ə',
    version = 4,
    provider_metadata = provider_metadata || '{"qa_correction":"v3_second_short_i_rendered_as_ee","provider_format":"pipe_delimited_ipa","stress_marker":"immediately_before_primary_vowel"}'::jsonb,
    updated_at = now()
where canonical_term = 'gingiva'
  and scope_type = 'industry'
  and industry_key = 'dental'
  and pronunciation_method = 'ipa'
  and verification_status = 'verified'
  and is_active
  and version = 3;

do $$
begin
  if (select count(*) from public.pronunciation_terms
      where canonical_term = 'gingiva'
        and scope_type = 'industry' and industry_key = 'dental'
        and pronunciation_method = 'ipa' and verification_status = 'verified'
        and is_active and version = 4
        and pronunciation_value = 'dʒ|ˈ|ɪ|n|dʒ|ɪ|v|ə') <> 1 then
    raise exception 'pronunciation_gingiva_stress_correction_mismatch';
  end if;

  if (select count(*) from public.pronunciation_terms
      where scope_type = 'industry' and industry_key = 'dental'
        and verification_status = 'verified' and is_active) <> 9 then
    raise exception 'pronunciation_gingiva_verified_count_mismatch';
  end if;
end;
$$;
