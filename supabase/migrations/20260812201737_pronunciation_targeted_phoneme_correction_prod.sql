-- Targeted human listening found three residual Sonic-3 phoneme errors in the
-- v2 raw IPA rules. Tavus officially supports pipe-delimited IPA, so tokenize
-- only the three failed terms while preserving the six owner-approved rules.

update public.pronunciation_terms as term
set pronunciation_value = correction.pronunciation_value,
    version = 3,
    provider_metadata = term.provider_metadata || correction.provider_metadata,
    updated_at = now()
from (values
  ('orthodontics', 'ˌ|ɔː|r|θ|oʊ|ˈ|d|ɑː|n|t̬|ɪ|k|s', '{"qa_correction":"v2_long_o_rendered_as_oo","provider_format":"pipe_delimited_ipa"}'::jsonb),
  ('gingiva', 'ˈ|dʒ|ɪ|n|dʒ|ɪ|v|ə', '{"qa_correction":"v2_second_short_i_rendered_as_ee","provider_format":"pipe_delimited_ipa"}'::jsonb),
  ('prophylaxis', 'ˌ|p|r|oʊ|f|ɪ|ˈ|l|æ|k|s|ɪ|s', '{"qa_correction":"v2_long_o_rendered_as_oo","provider_format":"pipe_delimited_ipa"}'::jsonb)
) as correction(canonical_term, pronunciation_value, provider_metadata)
where term.canonical_term = correction.canonical_term
  and term.scope_type = 'industry'
  and term.industry_key = 'dental'
  and term.pronunciation_method = 'ipa'
  and term.verification_status = 'verified'
  and term.is_active
  and term.version = 2;

do $$
begin
  if (select count(*) from public.pronunciation_terms
      where scope_type = 'industry' and industry_key = 'dental'
        and canonical_term in ('orthodontics', 'gingiva', 'prophylaxis')
        and pronunciation_method = 'ipa' and verification_status = 'verified'
        and is_active and version = 3) <> 3 then
    raise exception 'pronunciation_targeted_phoneme_correction_count_mismatch';
  end if;

  if (select count(*) from public.pronunciation_terms
      where scope_type = 'industry' and industry_key = 'dental'
        and verification_status = 'verified' and is_active) <> 9 then
    raise exception 'pronunciation_targeted_phoneme_verified_count_mismatch';
  end if;
end;
$$;
