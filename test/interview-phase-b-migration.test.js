'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260717120000_candidate_incident_phase_b.sql'), 'utf8');

test('Phase B migration preserves attempts and enforces one active candidate/role attempt', () => {
  assert.match(sql, /interviews_candidate_role_attempt_uidx/);
  assert.match(sql, /interviews_one_active_attempt_uidx/);
  assert.match(sql, /drop index if exists public\.uniq_interviews_candidate_role/);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.interviews/i);
  assert.doesNotMatch(sql, /truncate\s+public\.interviews/i);
});

test('Phase B migration protects reset audit data and internal RPCs', () => {
  assert.match(sql, /create table if not exists public\.interview_reset_events/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on function public\.authorize_interview_replacement/i);
  assert.match(sql, /grant execute on function public\.authorize_interview_replacement[\s\S]*to service_role/i);
  assert.match(sql, /set search_path = ''/i);
});
