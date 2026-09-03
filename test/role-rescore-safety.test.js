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
