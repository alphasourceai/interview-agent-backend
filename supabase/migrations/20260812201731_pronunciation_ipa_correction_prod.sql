-- Human listening found the v1 capitalized respelling aliases segmented and
-- incorrectly stressed by the QA Cartesia Sonic-3 voice. Replace the eight
-- lexical rules with continuous US IPA and render CBCT as literal letter sounds.

update public.pronunciation_terms as term
set pronunciation_method = correction.pronunciation_method,
    pronunciation_value = correction.pronunciation_value,
    version = 2,
    provider_metadata = correction.provider_metadata,
    updated_at = now()
from (values
  ('endodontics', 'ipa', 'ˌɛndoʊˈdɑntɪks', '{"category":"specialties","confidence":"high","evidence_url":"https://www.collinsdictionary.com/us/dictionary/english/endodontics","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('periodontics', 'ipa', 'ˌper.i.oʊˈdɑːn.t̬ɪks', '{"category":"specialties","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/pronunciation/english/periodontics","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('prosthodontics', 'ipa', 'ˌprɑːs.θoʊˈdɑːn.t̬ɪks', '{"category":"specialties","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/dictionary/english/prosthodontics","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('orthodontics', 'ipa', 'ˌɔːr.θoʊˈdɑːn.t̬ɪks', '{"category":"specialties","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/pronunciation/english/orthodontics","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('xerostomia', 'ipa', 'ˌzɪərəˈstoʊmiə', '{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://www.dictionary.com/browse/xerostomia","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('gingiva', 'ipa', 'ˈdʒɪn.dʒɪ.və', '{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/pronunciation/english/gingiva","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('periodontal', 'ipa', 'ˌper.i.oʊˈdɑːn.t̬əl', '{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/pronunciation/english/periodontal","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('CBCT', 'alias', 'see bee see tee', '{"category":"imaging_technology","confidence":"qa_correction_pending_retest","evidence_url":"https://www.ada.org/resources/research/science-and-research-institute/oral-health-topics/cone-beam-computed-tomography","reading":"initialism","qa_correction":"v1_alias_failed_human_listening"}'::jsonb),
  ('prophylaxis', 'ipa', 'ˌproʊ.fɪˈlæk.sɪs', '{"category":"procedures_materials","confidence":"high","evidence_url":"https://dictionary.cambridge.org/us/pronunciation/english/prophylaxis","qa_correction":"v1_alias_failed_human_listening"}'::jsonb)
) as correction(canonical_term, pronunciation_method, pronunciation_value, provider_metadata)
where term.canonical_term = correction.canonical_term
  and term.scope_type = 'industry'
  and term.industry_key = 'dental'
  and term.verification_status = 'verified';

do $$
begin
  if (select count(*) from public.pronunciation_terms
      where scope_type = 'industry' and industry_key = 'dental'
        and verification_status = 'verified' and is_active and version = 2) <> 9 then
    raise exception 'pronunciation_ipa_correction_count_mismatch';
  end if;
end;
$$;
