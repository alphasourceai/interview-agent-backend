'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('application boots without outbound vendor keys and rubric generation is explicitly unavailable', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    // The test may import all routes, but no network operation is allowed.
    global.fetch = () => { throw new Error('unexpected_outbound_request'); };
    require('./app');
    const { generateRubricForRole } = require('./src/services/generateRubric');
    assert.rejects(generateRubricForRole({
      role: { title: 'Synthetic Dev Role', interview_type: 'core' },
      jdText: 'Synthetic description', membershipLevel: 'pro'
    }), error => error.code === 'RUBRIC_GENERATION_UNAVAILABLE' && error.status === 503)
      .then(() => { console.log('KEYLESS_BOOT_PASS'); process.exit(0); })
      .catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production', APP_ENV: 'development',
      FRONTEND_URL: 'https://interview-agent-frontend-qa.onrender.com',
      CORS_ORIGINS: 'https://interview-agent-frontend-qa.onrender.com',
      SUPABASE_URL: 'https://hjombgfusdgsqipimhnc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      SUPABASE_ANON_KEY: 'test-anon-key'
    },
    timeout: 15000, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /KEYLESS_BOOT_PASS/);
});
