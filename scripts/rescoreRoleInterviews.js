'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const ROLE_TITLE = String(process.env.ROLE_RESCORE_TITLE || '').trim();
const EXPECTED_PROJECT_REF = String(process.env.ROLE_RESCORE_EXPECTED_PROJECT_REF || '').trim();
const EXPECTED_COUNT = Number(process.env.ROLE_RESCORE_EXPECTED_COUNT || 0);
const DRY_RUN = String(process.env.ROLE_RESCORE_DRY_RUN || 'true').toLowerCase() !== 'false';
const BACKUP_BUCKET = String(process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts').trim();

function assertRoleRescoreSafety() {
  if (process.env.ALLOW_ROLE_RESCORE !== 'true') throw new Error('role_rescore_explicit_opt_in_required');
  if (!ROLE_TITLE) throw new Error('role_rescore_title_required');
  if (!EXPECTED_PROJECT_REF) throw new Error('role_rescore_expected_project_ref_required');
  if (!Number.isInteger(EXPECTED_COUNT) || EXPECTED_COUNT < 1) throw new Error('role_rescore_expected_count_required');
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

async function restorePreviousValues(supabase, backupRows, updatedIds) {
  for (const row of backupRows) {
    if (!updatedIds.has(row.id)) continue;
    const { error } = await supabase
      .from('interviews')
      .update({
        transcript_scores: row.transcript_scores,
        interview_summary: row.interview_summary,
      })
      .eq('id', row.id);
    if (error) throw error;
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
    .select('id,role_id,client_id,transcript_scores,interview_summary,updated_at')
    .eq('role_id', role.id)
    .order('created_at', { ascending: true });
  if (interviewError) throw interviewError;

  const scoredInterviews = (interviews || []).filter((row) => Number.isFinite(row?.transcript_scores?.overall));
  if (scoredInterviews.length !== EXPECTED_COUNT) {
    throw new Error(`role_rescore_count_mismatch:expected_${EXPECTED_COUNT}:found_${scoredInterviews.length}`);
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
    if (!result.ok || result.skipped || !result.update_payload) {
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

  if (DRY_RUN) {
    console.log(JSON.stringify({
      outcome: 'dry_run_complete',
      role_title: ROLE_TITLE,
      interviews: results.length,
      prior_average: average(results.map((row) => row.prior_overall)),
      rescored_average: average(results.map((row) => row.rescored_overall)),
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

  const updatedIds = new Set();
  try {
    for (const result of results) {
      const { data: updated, error: updateError } = await supabase
        .from('interviews')
        .update(result.update_payload)
        .eq('id', result.id)
        .eq('role_id', role.id)
        .eq('client_id', role.client_id)
        .eq('updated_at', result.prior_updated_at)
        .select('id');
      if (updateError) throw updateError;
      if (!Array.isArray(updated) || updated.length !== 1) throw new Error('role_rescore_concurrent_update_detected');
      updatedIds.add(result.id);
    }

    const { data: verified, error: verifyError } = await supabase
      .from('interviews')
      .select('id,transcript_scores,interview_summary')
      .in('id', results.map((row) => row.id));
    if (verifyError) throw verifyError;
    if (!Array.isArray(verified) || verified.length !== EXPECTED_COUNT) throw new Error('role_rescore_verify_count_mismatch');
    if (verified.some((row) => !Number.isFinite(row?.transcript_scores?.overall) || !String(row?.interview_summary || '').trim())) {
      throw new Error('role_rescore_verify_content_invalid');
    }
  } catch (error) {
    await restorePreviousValues(supabase, backup.interviews, updatedIds);
    throw new Error(`role_rescore_rolled_back:${error?.message || error}`);
  }

  console.log(JSON.stringify({
    outcome: 'rescore_complete',
    role_title: ROLE_TITLE,
    interviews: results.length,
    prior_average: average(results.map((row) => row.prior_overall)),
    rescored_average: average(results.map((row) => row.rescored_overall)),
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

module.exports = { assertRoleRescoreSafety, average };
