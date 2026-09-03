'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, decryptBundle, validatePreparedPayload, transcriptDigest } = require('../scripts/importQaRoleScores');

const hashes = ['a'.repeat(64), 'b'.repeat(64)];

function environment(overrides = {}) {
  return {
    ALLOW_QA_SCORE_IMPORT: 'true',
    ROLE_SCORE_IMPORT_TITLE: 'High-Velocity Sales Closer',
    ROLE_SCORE_IMPORT_EXPECTED_PROJECT_REF: 'expected-project',
    ROLE_SCORE_IMPORT_EXPECTED_COUNT: '2',
    ROLE_SCORE_IMPORT_MAX_CREATED_AT: '2026-09-03T04:00:00Z',
    ROLE_SCORE_IMPORT_EXPECTED_TRANSCRIPT_HASHES: hashes.join(','),
    ROLE_SCORE_IMPORT_EXPECTED_OUTPUT_SCORES: '63,58',
    ROLE_SCORE_IMPORT_CALIBRATION_SET: 'high_velocity_sales_closer_2026_09_03',
    ROLE_SCORE_IMPORT_BUNDLE_BASE64: Buffer.from('{}').toString('base64'),
    ROLE_SCORE_IMPORT_BUNDLE_SHA256: crypto.createHash('sha256').update(Buffer.from('{}').toString('base64')).digest('hex'),
    ROLE_SCORE_IMPORT_PRIVATE_KEY_PATH: 'admin-rescore-transfer/key.pem',
    ROLE_SCORE_IMPORT_PRIVATE_KEY_SHA256: 'c'.repeat(64),
    ROLE_SCORE_IMPORT_DRY_RUN: 'true',
    SUPABASE_URL: 'https://expected-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ...overrides,
  };
}

function preparedPayload() {
  const score = (overall) => ({
    overall,
    role_fit: overall,
    technical_strength: overall,
    communication_quality: overall,
    confidence: 80,
    ai_aided_risk: 'low',
    ai_aided_risk_reason: 'No strong indicators.',
  });
  return {
    schema_version: 1,
    calibration_set: 'high_velocity_sales_closer_2026_09_03',
    created_at: new Date().toISOString(),
    cases: [
      { case_label: 'sales-closer-01', transcript_sha256: hashes[0], new_scores: score(63), new_summary: 'Summary one.', question_evaluations: Array(5).fill({}), scorer_version: 'role_rubric_v2' },
      { case_label: 'sales-closer-02', transcript_sha256: hashes[1], new_scores: score(58), new_summary: 'Summary two.', question_evaluations: Array(5).fill({}), scorer_version: 'role_rubric_v2' },
    ],
  };
}

function encrypt(payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const container = {
    schema_version: 1,
    alg: 'RSA-OAEP-SHA256+A256GCM',
    wrapped_key: crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return { bundle: Buffer.from(JSON.stringify(container)).toString('base64'), privateKey };
}

test('score import configuration is exact-project, exact-set, and explicit opt-in', () => {
  const config = loadConfig(environment());
  assert.equal(config.expectedCount, 2);
  assert.deepEqual(config.expectedOutputScores, [63, 58]);
  assert.throws(() => loadConfig(environment({ ALLOW_QA_SCORE_IMPORT: 'false' })), /explicit_opt_in/);
  assert.throws(() => loadConfig(environment({ SUPABASE_URL: 'https://wrong-project.supabase.co' })), /wrong_project/);
  assert.throws(() => loadConfig(environment({ ROLE_SCORE_IMPORT_EXPECTED_TRANSCRIPT_HASHES: `${hashes[0]},${hashes[0]}` })), /transcript_hashes_invalid/);
});

test('hybrid bundle decrypts with the private key and fails closed on tampering', () => {
  const payload = preparedPayload();
  const { bundle, privateKey } = encrypt(payload);
  assert.deepEqual(decryptBundle(bundle, privateKey), payload);
  const tampered = `${bundle.slice(0, -2)}AA`;
  assert.throws(() => decryptBundle(tampered, privateKey), /bundle_(decode|contract|decrypt)_failed|bundle_contract_invalid/);
});

test('prepared payload requires the exact transcript set and complete role-rubric results', () => {
  const config = loadConfig(environment());
  const payload = preparedPayload();
  const byHash = validatePreparedPayload(payload, config);
  assert.equal(byHash.get(hashes[0]).new_scores.overall, 63);
  const wrong = preparedPayload();
  wrong.cases[1].transcript_sha256 = 'd'.repeat(64);
  assert.throws(() => validatePreparedPayload(wrong, config), /payload_hash_set_mismatch/);
  const incomplete = preparedPayload();
  incomplete.cases[0].new_summary = '';
  assert.throws(() => validatePreparedPayload(incomplete, config), /payload_case_invalid/);
});

test('transcript digest is exact-body SHA-256', () => {
  assert.equal(transcriptDigest('body'), crypto.createHash('sha256').update('body').digest('hex'));
});

