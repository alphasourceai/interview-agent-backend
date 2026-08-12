'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812201729_pronunciation_registry_foundation_prod.sql'), 'utf8');
const correction = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812201731_pronunciation_ipa_correction_prod.sql'), 'utf8');
const targetedCorrection = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812201737_pronunciation_targeted_phoneme_correction_prod.sql'), 'utf8');
const gingivaStressCorrection = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812201742_pronunciation_gingiva_stress_correction_prod.sql'), 'utf8');
const gingivaAliasCorrection = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812201745_pronunciation_gingiva_continuous_alias_prod.sql'), 'utf8');

test('migration creates provider-neutral registry and sync binding', () => {
  assert.match(migration, /create table if not exists public\.pronunciation_terms/i);
  assert.match(migration, /create table if not exists public\.pronunciation_dictionary_syncs/i);
  assert.doesNotMatch(migration, /tavus_dictionary_id|elevenlabs_dictionary_id|cartesia_dictionary_id/i);
});

test('gingiva fallback uses one continuous lowercase alias without segmented respelling', () => {
  assert.match(gingivaAliasCorrection, /pronunciation_method = 'alias'/);
  assert.match(gingivaAliasCorrection, /pronunciation_value = 'jinjivuh'/);
  assert.match(gingivaAliasCorrection, /version = 5/);
  assert.doesNotMatch(gingivaAliasCorrection, /JIN-jih-vuh/);
  assert.match(gingivaAliasCorrection, /pronunciation_gingiva_continuous_alias_mismatch/);
});

test('gingiva correction places primary stress immediately before the first short-i vowel', () => {
  assert.match(gingivaStressCorrection, /version = 4/);
  assert.match(gingivaStressCorrection, /pronunciation_value = 'dʒ\|ˈ\|ɪ\|n\|dʒ\|ɪ\|v\|ə'/);
  assert.match(gingivaStressCorrection, /pronunciation_gingiva_stress_correction_mismatch/);
});

test('migration bounds scope, method, provenance, and verification state', () => {
  for (const value of ['global', 'industry', 'client', 'alias', 'ipa', 'suggested', 'verified', 'rejected', 'deprecated', 'ai_suggestion']) assert.match(migration, new RegExp(`'${value}'`));
  assert.match(migration, /pronunciation_terms_scope_binding_check/);
  assert.match(migration, /verification_status <> 'verified' or verified_at is not null/);
});

test('registry is RLS protected and browser roles have no grants', () => {
  assert.match(migration, /alter table public\.pronunciation_terms enable row level security/i);
  assert.match(migration, /revoke all privileges on table public\.pronunciation_terms from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.pronunciation_terms to service_role/i);
  assert.doesNotMatch(migration, /grant [^;]+pronunciation_terms[^;]+ to (anon|authenticated)/i);
  assert.match(migration, /alter table public\.pronunciation_dictionary_syncs enable row level security/i);
  assert.match(migration, /revoke all privileges on table public\.pronunciation_dictionary_syncs from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.pronunciation_dictionary_syncs to service_role/i);
  assert.doesNotMatch(migration, /grant [^;]+pronunciation_dictionary_syncs[^;]+ to (anon|authenticated)/i);
});

test('production seed contains only the nine verified terms', () => {
  assert.match(migration, /'prophylaxis'.*'verified'.*now\(\)/i);
  assert.doesNotMatch(migration, /'CAD\/CAM'/i);
  assert.doesNotMatch(migration, /'oral and maxillofacial surgery'/i);
});

test('human-listening correction replaces segmented aliases with bounded v2 rules', () => {
  assert.match(correction, /version = 2/);
  assert.match(correction, /'endodontics', 'ipa', 'ˌɛndoʊˈdɑntɪks'/);
  assert.match(correction, /'prophylaxis', 'ipa', 'ˌproʊ\.fɪˈlæk\.sɪs'/);
  assert.match(correction, /'CBCT', 'alias', 'see bee see tee'/);
  assert.match(correction, /pronunciation_ipa_correction_count_mismatch/);
});

test('targeted listening correction uses bounded pipe-delimited v3 IPA rules', () => {
  assert.match(targetedCorrection, /version = 3/);
  assert.match(targetedCorrection, /'orthodontics', 'ˌ\|ɔː\|r\|θ\|oʊ\|ˈ\|d\|ɑː\|n\|t̬\|ɪ\|k\|s'/);
  assert.match(targetedCorrection, /'gingiva', 'ˈ\|dʒ\|ɪ\|n\|dʒ\|ɪ\|v\|ə'/);
  assert.match(targetedCorrection, /'prophylaxis', 'ˌ\|p\|r\|oʊ\|f\|ɪ\|ˈ\|l\|æ\|k\|s\|ɪ\|s'/);
  assert.match(targetedCorrection, /pronunciation_targeted_phoneme_correction_count_mismatch/);
});
