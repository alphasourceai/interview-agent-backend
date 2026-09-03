'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const SCORE_KEYS = ['overall', 'role_fit', 'technical_strength', 'communication_quality'];

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function transcriptDigest(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return crypto.createHash('sha256').update(body).digest('hex');
}

function average(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function loadConfig(env = process.env) {
  const config = {
    allow: env.ALLOW_QA_SCORE_IMPORT === 'true',
    roleTitle: String(env.ROLE_SCORE_IMPORT_TITLE || '').trim(),
    expectedProjectRef: String(env.ROLE_SCORE_IMPORT_EXPECTED_PROJECT_REF || '').trim(),
    expectedCount: Number(env.ROLE_SCORE_IMPORT_EXPECTED_COUNT || 0),
    maxCreatedAt: String(env.ROLE_SCORE_IMPORT_MAX_CREATED_AT || '').trim(),
    expectedTranscriptHashes: csv(env.ROLE_SCORE_IMPORT_EXPECTED_TRANSCRIPT_HASHES).map((value) => value.toLowerCase()),
    expectedOutputScores: csv(env.ROLE_SCORE_IMPORT_EXPECTED_OUTPUT_SCORES).map(Number),
    calibrationSet: String(env.ROLE_SCORE_IMPORT_CALIBRATION_SET || '').trim(),
    bundleBase64: String(env.ROLE_SCORE_IMPORT_BUNDLE_BASE64 || '').trim(),
    bundleSha256: String(env.ROLE_SCORE_IMPORT_BUNDLE_SHA256 || '').trim().toLowerCase(),
    privateKeyPath: String(env.ROLE_SCORE_IMPORT_PRIVATE_KEY_PATH || '').trim(),
    privateKeySha256: String(env.ROLE_SCORE_IMPORT_PRIVATE_KEY_SHA256 || '').trim().toLowerCase(),
    bucket: String(env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts').trim(),
    dryRun: String(env.ROLE_SCORE_IMPORT_DRY_RUN || 'true').toLowerCase() !== 'false',
    supabaseUrl: String(env.SUPABASE_URL || '').trim(),
    serviceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY || ''),
  };

  if (!config.allow) throw new Error('qa_score_import_explicit_opt_in_required');
  if (!config.roleTitle) throw new Error('qa_score_import_title_required');
  if (!config.expectedProjectRef) throw new Error('qa_score_import_project_required');
  if (!Number.isInteger(config.expectedCount) || config.expectedCount < 1) throw new Error('qa_score_import_count_invalid');
  if (!config.maxCreatedAt || !Number.isFinite(Date.parse(config.maxCreatedAt))) throw new Error('qa_score_import_cutoff_invalid');
  if (config.expectedTranscriptHashes.length !== config.expectedCount ||
      new Set(config.expectedTranscriptHashes).size !== config.expectedCount ||
      config.expectedTranscriptHashes.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('qa_score_import_transcript_hashes_invalid');
  }
  if (config.expectedOutputScores.length !== config.expectedCount ||
      config.expectedOutputScores.some((value) => !Number.isInteger(value) || value < 0 || value > 100)) {
    throw new Error('qa_score_import_output_scores_invalid');
  }
  if (!/^[a-z0-9_]{1,100}$/.test(config.calibrationSet)) throw new Error('qa_score_import_calibration_set_invalid');
  if (!config.bundleBase64 || config.bundleBase64.length > 100000 || !/^[A-Za-z0-9+/=]+$/.test(config.bundleBase64)) {
    throw new Error('qa_score_import_bundle_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(config.bundleSha256)) throw new Error('qa_score_import_bundle_hash_invalid');
  if (!/^admin-rescore-transfer\/[A-Za-z0-9._-]+\.pem$/.test(config.privateKeyPath)) throw new Error('qa_score_import_key_path_invalid');
  if (!/^[a-f0-9]{64}$/.test(config.privateKeySha256)) throw new Error('qa_score_import_key_hash_invalid');
  if (!config.supabaseUrl || !config.serviceRoleKey) throw new Error('qa_score_import_supabase_credentials_required');
  const hostname = new URL(config.supabaseUrl).hostname;
  if (hostname !== `${config.expectedProjectRef}.supabase.co`) throw new Error('qa_score_import_wrong_project');
  return config;
}

function decryptBundle(bundleBase64, privateKeyPem) {
  let container;
  try {
    container = JSON.parse(Buffer.from(bundleBase64, 'base64').toString('utf8'));
  } catch {
    throw new Error('qa_score_import_bundle_decode_failed');
  }
  if (container?.schema_version !== 1 || container?.alg !== 'RSA-OAEP-SHA256+A256GCM') {
    throw new Error('qa_score_import_bundle_contract_invalid');
  }
  try {
    const key = crypto.privateDecrypt(
      { key: privateKeyPem, oaepHash: 'sha256' },
      Buffer.from(String(container.wrapped_key || ''), 'base64')
    );
    if (key.length !== 32) throw new Error('invalid_key_length');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(container.iv || ''), 'base64'));
    decipher.setAuthTag(Buffer.from(String(container.tag || ''), 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(container.ciphertext || ''), 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('qa_score_import_bundle_decrypt_failed');
  }
}

function validatePreparedPayload(payload, config) {
  if (!payload || payload.schema_version !== 1 || payload.calibration_set !== config.calibrationSet ||
      !Array.isArray(payload.cases) || payload.cases.length !== config.expectedCount) {
    throw new Error('qa_score_import_payload_contract_invalid');
  }
  if (!Number.isFinite(Date.parse(String(payload.created_at || ''))) ||
      Math.abs(Date.now() - Date.parse(payload.created_at)) > 24 * 60 * 60 * 1000) {
    throw new Error('qa_score_import_payload_stale');
  }

  const hashes = [];
  for (const item of payload.cases) {
    if (!item || !/^[a-z0-9-]{1,80}$/.test(String(item.case_label || '')) ||
        !/^[a-f0-9]{64}$/.test(String(item.transcript_sha256 || '')) ||
        item.scorer_version !== 'role_rubric_v2' ||
        !item.new_scores || !SCORE_KEYS.every((key) => Number.isInteger(item.new_scores[key]) && item.new_scores[key] >= 0 && item.new_scores[key] <= 100) ||
        !Number.isInteger(item.new_scores.confidence) || item.new_scores.confidence < 0 || item.new_scores.confidence > 100 ||
        !['low', 'medium', 'high'].includes(item.new_scores.ai_aided_risk) ||
        typeof item.new_scores.ai_aided_risk_reason !== 'string' || item.new_scores.ai_aided_risk_reason.length > 300 ||
        typeof item.new_summary !== 'string' || !item.new_summary.trim() || item.new_summary.length > 10000 ||
        !Array.isArray(item.question_evaluations) || item.question_evaluations.length !== 5) {
      throw new Error('qa_score_import_payload_case_invalid');
    }
    hashes.push(item.transcript_sha256);
  }
  if (new Set(hashes).size !== config.expectedCount ||
      [...hashes].sort().some((value, index) => value !== [...config.expectedTranscriptHashes].sort()[index])) {
    throw new Error('qa_score_import_payload_hash_set_mismatch');
  }
  return new Map(payload.cases.map((item) => [item.transcript_sha256, item]));
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function restore(supabase, role, backupRows, updatedVersions) {
  for (const row of backupRows) {
    const version = updatedVersions.get(row.id);
    if (!version) continue;
    const { data, error } = await supabase.from('interviews').update({
      transcript_scores: row.transcript_scores,
      interview_summary: row.interview_summary,
      updated_at: row.updated_at,
    }).eq('id', row.id).eq('role_id', role.id).eq('client_id', role.client_id).eq('updated_at', version).select('id');
    if (error || !Array.isArray(data) || data.length !== 1) throw new Error('qa_score_import_rollback_concurrent_update');
  }
}

async function main() {
  const config = loadConfig();
  if (crypto.createHash('sha256').update(config.bundleBase64).digest('hex') !== config.bundleSha256) {
    throw new Error('qa_score_import_bundle_hash_mismatch');
  }
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: keyObject, error: keyError } = await supabase.storage.from(config.bucket).download(config.privateKeyPath);
  if (keyError || !keyObject) throw new Error('qa_score_import_key_download_failed');
  const privateKey = Buffer.from(await keyObject.arrayBuffer());
  if (crypto.createHash('sha256').update(privateKey).digest('hex') !== config.privateKeySha256) {
    throw new Error('qa_score_import_key_hash_mismatch');
  }
  const payloadByHash = validatePreparedPayload(decryptBundle(config.bundleBase64, privateKey), config);

  const { data: roles, error: roleError } = await supabase.from('roles').select('id,title,client_id').eq('title', config.roleTitle);
  if (roleError || !Array.isArray(roles) || roles.length !== 1) throw new Error('qa_score_import_role_scope_invalid');
  const role = roles[0];
  const { data: rows, error: rowError } = await supabase.from('interviews')
    .select('id,role_id,client_id,transcript,transcript_scores,interview_summary,updated_at,created_at')
    .eq('role_id', role.id).lt('created_at', config.maxCreatedAt).order('created_at', { ascending: true });
  if (rowError) throw rowError;
  const targets = (rows || []).filter((row) => Number.isFinite(row?.transcript_scores?.overall));
  if (targets.length !== config.expectedCount || targets.some((row) => row.role_id !== role.id || row.client_id !== role.client_id)) {
    throw new Error('qa_score_import_target_scope_invalid');
  }

  const prepared = targets.map((row) => {
    const hash = transcriptDigest(row.transcript);
    const imported = payloadByHash.get(hash);
    if (!imported) throw new Error('qa_score_import_target_hash_mismatch');
    return {
      row,
      transcriptHash: hash,
      update: {
        transcript_scores: { ...row.transcript_scores, ...imported.new_scores },
        interview_summary: imported.new_summary,
      },
    };
  });
  const importedScores = prepared.map((item) => item.update.transcript_scores.overall);
  if (importedScores.some((value, index) => value !== config.expectedOutputScores[index])) {
    throw new Error('qa_score_import_ordered_scores_mismatch');
  }
  const priorScores = prepared.map((item) => Number(item.row.transcript_scores.overall));
  if (config.dryRun) {
    console.log(JSON.stringify({
      outcome: 'qa_score_import_dry_run_complete', role_title: config.roleTitle,
      interviews: prepared.length, prior_average: average(priorScores), imported_average: average(importedScores),
      imported_scores: importedScores, mutations: 0,
    }));
    return;
  }

  const backup = {
    schema_version: 1, created_at: new Date().toISOString(), project_ref: config.expectedProjectRef,
    role: { id: role.id, title: role.title, client_id: role.client_id },
    interviews: prepared.map(({ row }) => ({
      id: row.id, transcript_scores: row.transcript_scores,
      interview_summary: row.interview_summary, updated_at: row.updated_at,
    })),
  };
  const backupBody = JSON.stringify(backup);
  const backupSha256 = crypto.createHash('sha256').update(backupBody).digest('hex');
  const backupPath = `admin-rescore-backups/${safeTimestamp()}-${crypto.randomUUID()}.json`;
  const { error: backupError } = await supabase.storage.from(config.bucket).upload(backupPath, Buffer.from(backupBody), {
    contentType: 'application/json', upsert: false,
  });
  if (backupError) throw new Error('qa_score_import_backup_failed');

  const updatedVersions = new Map();
  try {
    for (const item of prepared) {
      const mutationTimestamp = new Date().toISOString();
      const { data, error } = await supabase.from('interviews').update({ ...item.update, updated_at: mutationTimestamp })
        .eq('id', item.row.id).eq('role_id', role.id).eq('client_id', role.client_id)
        .eq('updated_at', item.row.updated_at).select('id,updated_at');
      if (error || !Array.isArray(data) || data.length !== 1) throw new Error('qa_score_import_concurrent_update');
      updatedVersions.set(item.row.id, data[0].updated_at || mutationTimestamp);
    }
    const { data: verified, error: verifyError } = await supabase.from('interviews')
      .select('id,transcript_scores,interview_summary').in('id', prepared.map((item) => item.row.id));
    if (verifyError || !Array.isArray(verified) || verified.length !== config.expectedCount) throw new Error('qa_score_import_verify_count');
    const expected = new Map(prepared.map((item) => [item.row.id, item.update]));
    if (verified.some((row) => {
      const item = expected.get(row.id);
      return !item || SCORE_KEYS.some((key) => row?.transcript_scores?.[key] !== item.transcript_scores[key]) ||
        row?.transcript_scores?.confidence !== item.transcript_scores.confidence ||
        row?.transcript_scores?.ai_aided_risk !== item.transcript_scores.ai_aided_risk ||
        row?.transcript_scores?.ai_aided_risk_reason !== item.transcript_scores.ai_aided_risk_reason ||
        row.interview_summary !== item.interview_summary;
    })) throw new Error('qa_score_import_verify_content');
  } catch (error) {
    try {
      await restore(supabase, role, backup.interviews, updatedVersions);
    } catch (rollbackError) {
      throw new Error(`qa_score_import_rollback_failed:${error.message}:${rollbackError.message}`);
    }
    throw new Error(`qa_score_import_rolled_back:${error.message}`);
  }

  console.log(JSON.stringify({
    outcome: 'qa_score_import_complete', role_title: config.roleTitle, interviews: prepared.length,
    prior_average: average(priorScores), imported_average: average(importedScores), imported_scores: importedScores,
    backup_bucket: config.bucket, backup_path: backupPath, backup_sha256: backupSha256,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

module.exports = { loadConfig, decryptBundle, validatePreparedPayload, transcriptDigest };
