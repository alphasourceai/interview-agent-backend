'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function withEnvironment(overrides, callback) {
  const keys = Object.keys(overrides);
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    callback();
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('role rescore refuses to load without an explicit opt-in', () => {
  withEnvironment({ ALLOW_ROLE_RESCORE: undefined }, () => {
    delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
    const { assertRoleRescoreSafety } = require('../scripts/rescoreRoleInterviews');
    assert.throws(() => assertRoleRescoreSafety(), /explicit_opt_in_required/);
  });
});

test('role rescore refuses a Supabase project that does not match the explicit target', () => {
  withEnvironment({
    ALLOW_ROLE_RESCORE: 'true',
    ROLE_RESCORE_TITLE: 'High-Velocity Sales Closer',
    ROLE_RESCORE_EXPECTED_PROJECT_REF: 'expected-project',
    ROLE_RESCORE_EXPECTED_COUNT: '6',
    ROLE_RESCORE_MAX_CREATED_AT: '2026-09-03T04:00:00Z',
    ROLE_RESCORE_EXPECTED_TRANSCRIPT_HASHES: Array.from({ length: 6 }, (_, index) => String(index).padStart(64, '0')).join(','),
    SUPABASE_URL: 'https://different-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    OPENAI_API_KEY: 'test-openai-key',
  }, () => {
    delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
    const { assertRoleRescoreSafety } = require('../scripts/rescoreRoleInterviews');
    assert.throws(() => assertRoleRescoreSafety(), /role_rescore_wrong_project/);
  });
});

test('role rescore accepts a fully explicit and matching target contract', () => {
  withEnvironment({
    ALLOW_ROLE_RESCORE: 'true',
    ROLE_RESCORE_TITLE: 'High-Velocity Sales Closer',
    ROLE_RESCORE_EXPECTED_PROJECT_REF: 'expected-project',
    ROLE_RESCORE_EXPECTED_COUNT: '6',
    ROLE_RESCORE_MAX_CREATED_AT: '2026-09-03T04:00:00Z',
    ROLE_RESCORE_EXPECTED_TRANSCRIPT_HASHES: Array.from({ length: 6 }, (_, index) => String(index).padStart(64, '0')).join(','),
    SUPABASE_URL: 'https://expected-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    OPENAI_API_KEY: 'test-openai-key',
  }, () => {
    delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
    const { assertRoleRescoreSafety } = require('../scripts/rescoreRoleInterviews');
    assert.doesNotThrow(() => assertRoleRescoreSafety());
  });
});

test('role rescore average ignores missing values and rounds once', () => {
  delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
  const { average } = require('../scripts/rescoreRoleInterviews');
  assert.equal(average([70, 81, null, Number.NaN]), 76);
  assert.equal(average([70, 81]), 76);
  assert.equal(average([]), null);
});

test('role rescore rejects a missing cutoff before target selection', () => {
  withEnvironment({
    ALLOW_ROLE_RESCORE: 'true',
    ROLE_RESCORE_TITLE: 'High-Velocity Sales Closer',
    ROLE_RESCORE_EXPECTED_PROJECT_REF: 'expected-project',
    ROLE_RESCORE_EXPECTED_COUNT: '2',
    ROLE_RESCORE_MAX_CREATED_AT: undefined,
    ROLE_RESCORE_EXPECTED_TRANSCRIPT_HASHES: `${'a'.repeat(64)},${'b'.repeat(64)}`,
    SUPABASE_URL: 'https://expected-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    OPENAI_API_KEY: 'test-openai-key',
  }, () => {
    delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
    const { assertRoleRescoreSafety } = require('../scripts/rescoreRoleInterviews');
    assert.throws(() => assertRoleRescoreSafety(), /role_rescore_max_created_at_required/);
  });
});

test('role rescore rejects malformed or duplicate transcript fingerprints', () => {
  withEnvironment({
    ALLOW_ROLE_RESCORE: 'true',
    ROLE_RESCORE_TITLE: 'High-Velocity Sales Closer',
    ROLE_RESCORE_EXPECTED_PROJECT_REF: 'expected-project',
    ROLE_RESCORE_EXPECTED_COUNT: '2',
    ROLE_RESCORE_MAX_CREATED_AT: '2026-09-03T04:00:00Z',
    ROLE_RESCORE_EXPECTED_TRANSCRIPT_HASHES: `${'a'.repeat(64)},${'a'.repeat(64)}`,
    SUPABASE_URL: 'https://expected-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    OPENAI_API_KEY: 'test-openai-key',
  }, () => {
    delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
    const { assertRoleRescoreSafety } = require('../scripts/rescoreRoleInterviews');
    assert.throws(() => assertRoleRescoreSafety(), /role_rescore_expected_transcript_hashes_invalid/);
  });
});

test('role rescore normalizes transcript hashes and fingerprints the exact body', () => {
  delete require.cache[require.resolve('../scripts/rescoreRoleInterviews')];
  const { parseTranscriptHashes, transcriptDigest } = require('../scripts/rescoreRoleInterviews');
  const upper = 'A'.repeat(64);
  assert.deepEqual(parseTranscriptHashes(` ${upper}, ${'b'.repeat(64)} `), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(
    transcriptDigest('exact transcript'),
    require('node:crypto').createHash('sha256').update('exact transcript').digest('hex')
  );
});
