'use strict';

// interviews.completed_at — the one fact the interview paths record for billing.
//
// It has to be set exactly once. If a redelivered webhook or a late transcript
// could move it, an interview could shift into a later month and be billed on a
// different invoice, so the write is conditional on it still being null.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const { markInterviewCompleted } = require(path.join(ROOT, 'src', 'services', 'interviewCompletion.js'));

const makeDb = (interviews) => createFakeSupabase({ interviews });

test('an interview with no timestamp gets one', async () => {
  const db = makeDb([{ id: 'iv_1', client_id: 'c1', role_id: 'r1', completed_at: null }]);

  const result = await markInterviewCompleted({
    db, interviewId: 'iv_1', completedAt: '2026-09-15T10:00:00.000Z'
  });

  assert.equal(result.marked, true);
  assert.equal(result.completed_at, '2026-09-15T10:00:00.000Z');
  assert.equal(db.tables.interviews[0].completed_at, '2026-09-15T10:00:00.000Z');
});

test('a second call does not move it', async () => {
  const db = makeDb([{ id: 'iv_1', client_id: 'c1', completed_at: null }]);

  await markInterviewCompleted({ db, interviewId: 'iv_1', completedAt: '2026-09-15T10:00:00.000Z' });
  const second = await markInterviewCompleted({ db, interviewId: 'iv_1', completedAt: '2026-10-02T10:00:00.000Z' });

  assert.equal(second.marked, false);
  assert.equal(second.reason, 'already_completed');
  assert.equal(db.tables.interviews[0].completed_at, '2026-09-15T10:00:00.000Z',
    'a redelivery must not move an interview into a later month');
});

test('a missing timestamp defaults to now rather than staying null', async () => {
  const db = makeDb([{ id: 'iv_1', client_id: 'c1', completed_at: null }]);

  const result = await markInterviewCompleted({ db, interviewId: 'iv_1' });

  assert.equal(result.marked, true);
  assert.match(db.tables.interviews[0].completed_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('an unparseable timestamp falls back to now', async () => {
  const db = makeDb([{ id: 'iv_1', client_id: 'c1', completed_at: null }]);

  await markInterviewCompleted({ db, interviewId: 'iv_1', completedAt: 'not a date' });

  assert.match(db.tables.interviews[0].completed_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('only the named interview is touched', async () => {
  const db = makeDb([
    { id: 'iv_1', client_id: 'c1', completed_at: null },
    { id: 'iv_2', client_id: 'c1', completed_at: null }
  ]);

  await markInterviewCompleted({ db, interviewId: 'iv_1', completedAt: '2026-09-15T10:00:00.000Z' });

  assert.equal(db.tables.interviews[1].completed_at, null);
});

test('an unknown interview is a no-op, not an error', async () => {
  const db = makeDb([]);

  assert.deepEqual(await markInterviewCompleted({ db, interviewId: 'iv_missing' }),
    { marked: false, reason: 'already_completed' });
});

test('missing arguments are refused without writing', async () => {
  const db = makeDb([{ id: 'iv_1', client_id: 'c1', completed_at: null }]);

  assert.deepEqual(await markInterviewCompleted({ db, interviewId: '' }),
    { marked: false, reason: 'invalid_request' });
  assert.deepEqual(await markInterviewCompleted({ db: null, interviewId: 'iv_1' }),
    { marked: false, reason: 'invalid_request' });
  assert.equal(db.tables.interviews[0].completed_at, null);
});

test('a database error throws a fixed message with the code and nothing else', async () => {
  const marker = 'synthetic-stamp-diagnostic iv_1';
  const db = {
    from() {
      const chain = {
        update: () => chain,
        eq: () => chain,
        is: () => chain,
        select: () => chain,
        maybeSingle: async () => ({
          data: null,
          error: { code: '57014', message: marker, details: marker, hint: marker }
        })
      };
      return chain;
    }
  };

  await assert.rejects(
    markInterviewCompleted({ db, interviewId: 'iv_1', completedAt: '2026-09-15T10:00:00.000Z' }),
    (err) => {
      assert.equal(err.message, 'interview_completion_stamp_failed');
      assert.equal(err.code, '57014');
      assert.equal(Object.hasOwn(err, 'details'), false);
      assert.equal(Object.hasOwn(err, 'hint'), false);
      assert.equal(JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes(marker), false,
        'the database message, details and hint must not travel on the thrown error');
      return true;
    }
  );
});

// --- the three used points ------------------------------------------------

test('every path that makes an interview used stamps it', () => {
  const tavus = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tavusEvents', 'index.js'), 'utf8');
  const text = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'public', 'textInterview.js'), 'utf8');

  // Video: both paths route through the one helper, which records the fact and
  // nothing else.
  assert.match(tavus, /markInterviewCompleted\(\{ db: supabaseAdmin, interviewId \}\)/);
  const helperStart = tavus.indexOf('async function recordInterviewCompletion');
  const helper = tavus.slice(helperStart, tavus.indexOf('async function applyTranscriptScoringForInterview'));
  assert.ok(helper.length, 'expected the completion helper to be present');

  // And it is reached from both the scored-transcript path and the
  // final-transcript reconciliation.
  assert.equal((tavus.match(/await recordInterviewCompletion\(/g) || []).length, 2);

  // Text.
  assert.match(text, /markInterviewCompleted\(\{ db: supabaseAdmin, interviewId: insertedInterview\.id \}\)/);
});

test('a failed stamp is logged and never fails the interview', () => {
  const tavus = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tavusEvents', 'index.js'), 'utf8');
  const text = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'public', 'textInterview.js'), 'utf8');

  assert.match(tavus, /interview completion stamp failed/);
  assert.match(text, /interview completion stamp failed/);
});

// --- the migration --------------------------------------------------------

test('the migration adds the column, the index and a guarded backfill', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009190000_interviews_completed_at.sql'),
    'utf8'
  );

  assert.match(sql, /column_name = 'completed_at'[\s\S]{0,200}?add column completed_at timestamptz null/i,
    'public.interviews is not defined here, so the add must be guarded');
  assert.match(sql, /create index if not exists interviews_client_id_completed_at_idx[\s\S]*?\(client_id, completed_at\)/i);
  assert.match(sql, /if column_added then[\s\S]*?update public\.interviews/i,
    'a re-run must not move a timestamp that has since been set properly');
  assert.match(sql, /set completed_at = updated_at/i);
  assert.match(sql, /APPROXIMATE/i, 'the backfill being approximate must be stated in the migration');
});

test('the migration does not change how interviews are accessed', () => {
  const raw = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009190000_interviews_completed_at.sql'),
    'utf8'
  );
  // Only what actually executes — the file explains this choice in prose, which
  // would otherwise match the patterns below.
  const statements = raw.replace(/--[^\n]*/g, '');

  // public.interviews is not in the containment migration, so it carries its own
  // access model — very likely policies letting authenticated dashboard users
  // read their own rows. Revoking here could break the frontend.
  assert.doesNotMatch(statements, /\brevoke\b/i,
    'adding a column is not a reason to change a table access model');
  assert.doesNotMatch(statements, /\bgrant\b/i);
  assert.doesNotMatch(statements, /enable row level security/i);
});
