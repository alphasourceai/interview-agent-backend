'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const ROLE_TITLE = String(process.env.ROLE_RESCORE_TITLE || '').trim();
const EXPECTED_PROJECT_REF = String(process.env.ROLE_RESCORE_EXPECTED_PROJECT_REF || '').trim();
const EXPECTED_COUNT = Number(process.env.ROLE_RESCORE_EXPECTED_COUNT || 0);
const MAX_CREATED_AT = String(process.env.ROLE_RESCORE_MAX_CREATED_AT || '').trim();
const EXPECTED_TRANSCRIPT_HASHES = parseTranscriptHashes(process.env.ROLE_RESCORE_EXPECTED_TRANSCRIPT_HASHES);
const DRY_RUN = String(process.env.ROLE_RESCORE_DRY_RUN || 'true').toLowerCase() !== 'false';
const EXPECTED_OUTPUT_SCORES = parseExpectedScores(process.env.ROLE_RESCORE_EXPECTED_OUTPUT_SCORES);
const BACKUP_BUCKET = String(process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts').trim();

function parseTranscriptHashes(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function transcriptDigest(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return crypto.createHash('sha256').update(body).digest('hex');
}

function parseExpectedScores(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number);
}

function assertRoleRescoreSafety() {
  if (process.env.ALLOW_ROLE_RESCORE !== 'true') throw new Error('role_rescore_explicit_opt_in_required');
  if (!ROLE_TITLE) throw new Error('role_rescore_title_required');
  if (!EXPECTED_PROJECT_REF) throw new Error('role_rescore_expected_project_ref_required');
  if (!Number.isInteger(EXPECTED_COUNT) || EXPECTED_COUNT < 1) throw new Error('role_rescore_expected_count_required');
  if (!MAX_CREATED_AT || !Number.isFinite(Date.parse(MAX_CREATED_AT))) throw new Error('role_rescore_max_created_at_required');
  if (EXPECTED_TRANSCRIPT_HASHES.length !== EXPECTED_COUNT ||
      new Set(EXPECTED_TRANSCRIPT_HASHES).size !== EXPECTED_COUNT ||
      EXPECTED_TRANSCRIPT_HASHES.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('role_rescore_expected_transcript_hashes_invalid');
  }
  if (!DRY_RUN && (EXPECTED_OUTPUT_SCORES.length !== EXPECTED_COUNT ||
      EXPECTED_OUTPUT_SCORES.some((value) => !Number.isInteger(value) || value < 0 || value > 100))) {
    throw new Error('role_rescore_expected_output_scores_invalid');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('role_rescore_supabase_credentials_required');
  if (!process.env.OPENAI_API_KEY) throw new Error('role_rescore_openai_key_required');

  const hostname = new URL(process.env.SUPABASE_URL).hostname;
  if (hostname !== `${EXPECTED_PROJECT_REF}.supabase.co`) {
    throw new Error(`role_rescore_wrong_project:${hostname || 'missing'}`);
  }
}

function average(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) return null;
  return Math.round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function restorePreviousValues(supabase, role, backupRows, updatedVersions) {
  for (const row of backupRows) {
    const updatedAt = updatedVersions.get(row.id);
    if (!updatedAt) continue;
    const { data: restored, error } = await supabase
      .from('interviews')
      .update({
        transcript_scores: row.transcript_scores,
        interview_summary: row.interview_summary,
        updated_at: row.updated_at,
      })
      .eq('id', row.id)
      .eq('role_id', role.id)
      .eq('client_id', role.client_id)
      .eq('updated_at', updatedAt)
      .select('id');
    if (error) throw error;
    if (!Array.isArray(restored) || restored.length !== 1) {
      throw new Error(`role_rescore_rollback_concurrent_update:${row.id}`);
    }
  }
}

async function main() {
  assertRoleRescoreSafety();
  // Load the scoring worker only after every explicit environment and target
  // guard passes. The worker initializes its Supabase client at module load.
  const { analyzeInterviewTranscriptById } = require('./backfillInterviews');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: roles, error: roleError } = await supabase
    .from('roles')
    .select('id,title,client_id')
    .eq('title', ROLE_TITLE);
  if (roleError) throw roleError;
  if (!Array.isArray(roles) || roles.length !== 1) {
    throw new Error(`role_rescore_expected_one_role:${Array.isArray(roles) ? roles.length : 'invalid'}`);
  }

  const role = roles[0];
  const { data: interviews, error: interviewError } = await supabase
    .from('interviews')
    .select('id,role_id,client_id,transcript,transcript_scores,interview_summary,updated_at')
    .eq('role_id', role.id)
    .lt('created_at', MAX_CREATED_AT)
    .order('created_at', { ascending: true });
  if (interviewError) throw interviewError;

  const scoredInterviews = (interviews || []).filter((row) => Number.isFinite(row?.transcript_scores?.overall));
  if (scoredInterviews.length !== EXPECTED_COUNT) {
    throw new Error(`role_rescore_count_mismatch:expected_${EXPECTED_COUNT}:found_${scoredInterviews.length}`);
  }
  const actualTranscriptHashes = scoredInterviews.map((row) => transcriptDigest(row.transcript)).sort();
  const expectedTranscriptHashes = [...EXPECTED_TRANSCRIPT_HASHES].sort();
  if (actualTranscriptHashes.some((value, index) => value !== expectedTranscriptHashes[index])) {
    throw new Error('role_rescore_transcript_set_mismatch');
  }
  if (scoredInterviews.some((row) => row.client_id !== role.client_id || row.role_id !== role.id)) {
    throw new Error('role_rescore_scope_mismatch');
  }

  const backup = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    project_ref: EXPECTED_PROJECT_REF,
    role: { id: role.id, title: role.title, client_id: role.client_id },
    interviews: scoredInterviews.map((row) => ({
      id: row.id,
      transcript_scores: row.transcript_scores,
      interview_summary: row.interview_summary,
      updated_at: row.updated_at,
    })),
  };
  const backupBody = JSON.stringify(backup);
  const backupDigest = crypto.createHash('sha256').update(backupBody).digest('hex');
  const backupPath = `admin-rescore-backups/${safeTimestamp()}-${crypto.randomUUID()}.json`;

  const results = [];
  for (const row of scoredInterviews) {
    const result = await analyzeInterviewTranscriptById(row.id, {
      dry_run: true,
      force_rescore: true,
      return_payload: true,
      request_id: `role-rescore-${crypto.randomUUID()}`,
    });
    if (!result.ok || result.skipped || !result.update_payload || !Number.isFinite(result.rescored_overall)) {
      throw new Error(`role_rescore_preparation_failed:${result.error || result.reason || 'unknown'}`);
    }
    results.push({
      id: row.id,
      prior_updated_at: row.updated_at,
      prior_overall: result.prior_overall,
      rescored_overall: result.rescored_overall,
      update_payload: result.update_payload,
    });
  }

  const rescoredScores = results.map((row) => row.rescored_overall);
  if (!DRY_RUN && rescoredScores.some((value, index) => value !== EXPECTED_OUTPUT_SCORES[index])) {
    throw new Error('role_rescore_output_scores_mismatch');
  }

  if (DRY_RUN) {
    console.log(JSON.stringify({
      outcome: 'dry_run_complete',
      role_title: ROLE_TITLE,
      interviews: results.length,
      prior_average: average(results.map((row) => row.prior_overall)),
      rescored_average: average(results.map((row) => row.rescored_overall)),
      rescored_scores: rescoredScores,
      mutations: 0,
    }));
    return;
  }

  const { error: backupError } = await supabase.storage
    .from(BACKUP_BUCKET)
    .upload(backupPath, Buffer.from(backupBody, 'utf8'), {
      contentType: 'application/json',
      upsert: false,
    });
  if (backupError) throw new Error(`role_rescore_backup_failed:${backupError.message}`);

  const updatedVersions = new Map();
  try {
    for (const result of results) {
      const mutationTimestamp = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from('interviews')
        .update({ ...result.update_payload, updated_at: mutationTimestamp })
        .eq('id', result.id)
        .eq('role_id', role.id)
        .eq('client_id', role.client_id)
        .eq('updated_at', result.prior_updated_at)
        .select('id,updated_at');
      if (updateError) throw updateError;
      if (!Array.isArray(updated) || updated.length !== 1) throw new Error('role_rescore_concurrent_update_detected');
      updatedVersions.set(result.id, updated[0].updated_at || mutationTimestamp);
    }

    const { data: verified, error: verifyError } = await supabase
      .from('interviews')
      .select('id,transcript_scores,interview_summary')
      .in('id', results.map((row) => row.id));
    if (verifyError) throw verifyError;
    if (!Array.isArray(verified) || verified.length !== EXPECTED_COUNT) throw new Error('role_rescore_verify_count_mismatch');
    const expectedById = new Map(results.map((row) => [row.id, row.update_payload]));
    if (verified.some((row) => {
      const expected = expectedById.get(row.id);
      return !expected ||
        Number(row?.transcript_scores?.overall) !== Number(expected?.transcript_scores?.overall) ||
        String(row?.interview_summary || '') !== String(expected?.interview_summary || '');
    })) {
      throw new Error('role_rescore_verify_content_invalid');
    }
  } catch (error) {
    try {
      await restorePreviousValues(supabase, role, backup.interviews, updatedVersions);
    } catch (rollbackError) {
      throw new Error(`role_rescore_rollback_failed:${error?.message || error}:${rollbackError?.message || rollbackError}`);
    }
    throw new Error(`role_rescore_rolled_back:${error?.message || error}`);
  }

  console.log(JSON.stringify({
    outcome: 'rescore_complete',
    role_title: ROLE_TITLE,
    interviews: results.length,
    prior_average: average(results.map((row) => row.prior_overall)),
    rescored_average: average(results.map((row) => row.rescored_overall)),
    rescored_scores: rescoredScores,
    backup_bucket: BACKUP_BUCKET,
    backup_path: backupPath,
    backup_sha256: backupDigest,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

module.exports = { assertRoleRescoreSafety, average, parseTranscriptHashes, transcriptDigest, parseExpectedScores };
