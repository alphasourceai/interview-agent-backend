'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('candidate OTP issuance does not use Math.random or persist plaintext codes', () => {
  const source = read('routes/candidateSubmit.js');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\.from\(['"]otp_tokens['"]\)\.insert/);
});

test('OTP verification is challenge-addressed and never compares a stored plaintext code', () => {
  const source = read('routes/verifyOtp.js');
  assert.match(source, /challenge_id/);
  assert.doesNotMatch(source, /token\.code/);
  assert.doesNotMatch(source, /select\(['"][^'"]*\bcode\b/);
});

test('interview launch is protected by an HttpOnly launch capability', () => {
  const source = read('routes/createTavusInterview.js');
  assert.match(source, /requireOtpLaunchCapability/);
  assert.match(source, /clearOtpLaunchCapability/);
});

test('legacy cleanup preserves neutralized OTP history after durable cutover', () => {
  const source = read('app.js');
  const cleanup = source.slice(
    source.indexOf("app.post('/internal/otp/cleanup'"),
    source.indexOf("app.post('/internal/recordings/cleanup'"),
  );
  assert.match(cleanup, /\.from\(['"]otp_tokens['"]\)[\s\S]*?\.delete\(\)[\s\S]*?\.neq\(['"]code['"],\s*['"]\[removed\]['"]\)/);
});
