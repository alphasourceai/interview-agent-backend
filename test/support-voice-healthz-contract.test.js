const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('process health stays local while support provider availability degrades independently', () => {
  const start = source.indexOf("app.get('/healthz'");
  const end = source.indexOf('// Sentry error handler', start);
  const health = source.slice(start, end);
  assert.match(health, /ok: supabase_auth\.ok === true && tavus_webhook_auth\.ok === true && \(support_voice\.enabled !== true \|\| support_voice\.configured === true\)/);
  assert.match(health, /degraded: .*support_voice\.available !== true/);
  assert.doesNotMatch(health, /ok: .*support_voice\.available === true/);
});
