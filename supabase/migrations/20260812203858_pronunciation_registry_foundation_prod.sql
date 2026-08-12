-- Provider-neutral pronunciation registry. Tavus is a synchronization target,
-- never the source of truth. Production browser roles intentionally receive no access.

create table if not exists public.pronunciation_terms (
  id uuid primary key default gen_random_uuid(),
  canonical_term text not null,
  normalized_term text not null,
  pronunciation_method text not null,
  pronunciation_value text not null,
  scope_type text not null,
  industry_key text,
  client_id uuid references public.clients(id) on delete cascade,
  source text not null,
  verification_status text not null default 'suggested',
  is_active boolean not null default true,
  version integer not null default 1,
  case_sensitive boolean not null default false,
  word_boundaries boolean not null default true,
  provider_metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  verified_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pronunciation_terms_canonical_length check (char_length(canonical_term) between 1 and 200),
  constraint pronunciation_terms_normalized_length check (char_length(normalized_term) between 1 and 200),
  constraint pronunciation_terms_normalized_shape_check check (
    normalized_term = lower(normalized_term)
    and normalized_term = btrim(normalized_term)
    and normalized_term !~ '[[:space:]]{2,}'
  ),
  constraint pronunciation_terms_value_length check (char_length(pronunciation_value) between 1 and 500),
  constraint pronunciation_terms_method_check check (pronunciation_method in ('alias', 'ipa')),
  constraint pronunciation_terms_scope_check check (scope_type in ('global', 'industry', 'client')),
  constraint pronunciation_terms_source_check check (source in ('manual', 'industry_seed', 'client_admin', 'role_discovery', 'qa_observed_failure', 'ai_suggestion')),
  constraint pronunciation_terms_verification_check check (verification_status in ('suggested', 'verified', 'rejected', 'deprecated')),
  constraint pronunciation_terms_version_check check (version > 0),
  constraint pronunciation_terms_scope_binding_check check (
    (scope_type = 'global' and industry_key is null and client_id is null)
    or (scope_type = 'industry' and industry_key is not null and client_id is null)
    or (scope_type = 'client' and industry_key is null and client_id is not null)
  ),
  constraint pronunciation_terms_industry_key_check check (
    industry_key is null or industry_key ~ '^[a-z][a-z0-9_-]{0,63}$'
  ),
  constraint pronunciation_terms_metadata_check check (
    jsonb_typeof(provider_metadata) = 'object'
    and octet_length(provider_metadata::text) <= 4096
  ),
  constraint pronunciation_terms_verified_at_check check (
    verification_status <> 'verified' or verified_at is not null
  )
);

create unique index if not exists pronunciation_terms_scope_identity_uidx
  on public.pronunciation_terms (
    normalized_term,
    scope_type,
    coalesce(industry_key, ''),
    coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index if not exists pronunciation_terms_runtime_idx
  on public.pronunciation_terms (scope_type, industry_key, client_id, normalized_term)
  where is_active and verification_status = 'verified';

alter table public.pronunciation_terms enable row level security;
alter table public.pronunciation_terms owner to postgres;
revoke all privileges on table public.pronunciation_terms from public, anon, authenticated;
grant select, insert, update, delete on table public.pronunciation_terms to service_role;

comment on table public.pronunciation_terms is
  'alphaScreen-owned provider-neutral pronunciation rules. Only verified active records may be synchronized by trusted backend code.';

create table if not exists public.pronunciation_dictionary_syncs (
  id uuid primary key default gen_random_uuid(),
  dictionary_key text not null unique,
  environment text not null,
  provider text not null,
  provider_dictionary_id text,
  source_hash text,
  provider_payload_hash text,
  term_count integer not null default 0,
  attached_pal_id text,
  sync_state text not null default 'planned',
  last_error_category text,
  synchronized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pronunciation_dictionary_syncs_environment_check check (environment in ('qa', 'production')),
  constraint pronunciation_dictionary_syncs_provider_check check (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  constraint pronunciation_dictionary_syncs_dictionary_key_length check (char_length(dictionary_key) between 1 and 160),
  constraint pronunciation_dictionary_syncs_provider_id_length check (provider_dictionary_id is null or char_length(provider_dictionary_id) between 1 and 160),
  constraint pronunciation_dictionary_syncs_hashes_check check (
    (source_hash is null or source_hash ~ '^[0-9a-f]{64}$')
    and (provider_payload_hash is null or provider_payload_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint pronunciation_dictionary_syncs_count_check check (term_count >= 0),
  constraint pronunciation_dictionary_syncs_state_check check (sync_state in ('planned', 'creating', 'updating', 'attaching', 'synchronized', 'create_ambiguous', 'update_ambiguous', 'attachment_ambiguous', 'failed')),
  constraint pronunciation_dictionary_syncs_error_check check (last_error_category is null or last_error_category ~ '^[a-z][a-z0-9_]{0,63}$')
);

create unique index if not exists pronunciation_dictionary_syncs_provider_binding_uidx
  on public.pronunciation_dictionary_syncs (provider, provider_dictionary_id)
  where provider_dictionary_id is not null;

alter table public.pronunciation_dictionary_syncs enable row level security;
alter table public.pronunciation_dictionary_syncs owner to postgres;
revoke all privileges on table public.pronunciation_dictionary_syncs from public, anon, authenticated;
grant select, insert, update, delete on table public.pronunciation_dictionary_syncs to service_role;

comment on table public.pronunciation_dictionary_syncs is
  'Server-only binding between a deterministic alphaScreen dictionary key and one provider dictionary resource.';

insert into public.pronunciation_terms (
  canonical_term, normalized_term, pronunciation_method, pronunciation_value,
  scope_type, industry_key, source, verification_status, is_active, version,
  case_sensitive, word_boundaries, provider_metadata, verified_at
)
values
  ('endodontics','endodontics','alias','en-doh-DON-tiks','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"specialties","confidence":"high","evidence_url":"https://www.merriam-webster.com/dictionary/endodontics"}',now()),
  ('periodontics','periodontics','alias','pair-ee-oh-DON-tiks','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"specialties","confidence":"high","evidence_url":"https://www.merriam-webster.com/dictionary/periodontics"}',now()),
  ('prosthodontics','prosthodontics','alias','pros-thoh-DON-tiks','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"specialties","confidence":"high","evidence_url":"https://www.merriam-webster.com/dictionary/prosthodontics"}',now()),
  ('orthodontics','orthodontics','alias','or-thoh-DON-tiks','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"specialties","confidence":"high","evidence_url":"https://www.merriam-webster.com/dictionary/orthodontics"}',now()),
  ('xerostomia','xerostomia','alias','ZEER-oh-STOH-mee-uh','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://www.cancer.gov/publications/dictionaries/cancer-terms/def/xerostomia"}',now()),
  ('gingiva','gingiva','alias','JIN-jih-vuh','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://www.cancer.gov/publications/dictionaries/cancer-terms/def/gingiva"}',now()),
  ('periodontal','periodontal','alias','pair-ee-oh-DON-tul','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"clinical_anatomy","confidence":"high","evidence_url":"https://www.merriam-webster.com/dictionary/periodontal"}',now()),
  ('CBCT','cbct','alias','C B C T','industry','dental','industry_seed','verified',true,1,true,true,'{"category":"imaging_technology","confidence":"curated","evidence_url":"https://www.ada.org/resources/research/science-and-research-institute/oral-health-topics/cone-beam-computed-tomography","reading":"letters"}',now()),
  ('prophylaxis','prophylaxis','alias','PROH-fih-LAK-sis','industry','dental','industry_seed','verified',true,1,false,true,'{"category":"procedures_materials","confidence":"high","evidence_url":"https://www.cancer.gov/publications/dictionaries/cancer-terms/def/prophylaxis"}',now())
on conflict do nothing;
