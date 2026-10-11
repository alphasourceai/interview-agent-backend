'use strict';

// Enterprise interviews run at the client's own length and scored question
// count (Step E4). Essentials and Pro always run at their plan values. A child
// entity gets its billing owner's values. A role keeps the length and question
// count its rubric was generated with, so a later change to the client's
// settings reaches only roles created afterwards.
//
// The capacity resolver, the rubric generator and the provider call limit are
// the real ones. Supabase, storage and OpenAI are stubbed; no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { guardPlanSettingsNotNull } = require('./helpers/planSettingsNotNull');

// The rubric module builds its OpenAI client on load; every call here passes a stub.
process.env.OPENAI_API_KEY ||= 'enterprise-capacity-openai-key';

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
if (!require.cache[supabasePath]) {
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
  };
}

const {
  INTERNAL_SYNTHETIC_CLIENT_IDS_ENV,
  PLAN_CAPACITY,
  resolvePlanCapacityForClient,
  resolveRoleInterviewCapacity
} = require('../src/services/planCapacity');
const { buildRubricPrompt, generateJdDerivedArtifactsForRole } = require('../src/services/generateRubric');
const { resolveProviderMaxCallDurationSeconds, PROVIDER_CLOSING_GRACE_SECONDS } = require('../src/services/interviewDuration');

const PARENT = 'client_parent';
const CHILD = 'client_child';
const NO_SYNTHETIC = Object.freeze({});

function makeDb(planSettings) {
  const db = createFakeSupabase({
    clients: [
      { id: PARENT, parent_client_id: null, name: 'Parent Co' },
      { id: CHILD, parent_client_id: PARENT, name: 'Child Entity', entity_label: 'Child' }
    ],
    client_plan_settings: [{ client_id: PARENT, ...planSettings }]
  });
  db.storage = { from: () => ({ upload: async () => ({ data: { path: 'kb' }, error: null }) }) };
  return guardPlanSettingsNotNull(db);
}

const capacityFor = (db, clientId = PARENT, env = NO_SYNTHETIC) => resolvePlanCapacityForClient({ db, clientId, env });

// No OpenAI answer, so the generator builds its deterministic fallback rubric at
// the requested count — the same path a real outage takes.
const silentOpenAi = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } } };

async function createRole(db, { id, clientId = PARENT, title = 'Operations Lead' } = {}) {
  const role = { id, client_id: clientId, title, interview_type: 'core' };
  const artifacts = await generateJdDerivedArtifactsForRole(
    { role, jdText: 'Leads daily operations and reports to the COO.' },
    { supabaseClient: db, openaiClient: silentOpenAi, logger: { error() {}, warn() {}, info() {} }, kbId: `kb_${id}` }
  );
  return { ...role, rubric: artifacts.rubric, rubric_questions: artifacts.rubric_questions };
}

const setSettings = (db, values) => Object.assign(db.tables.client_plan_settings[0], values);

// --- the client's capacity ------------------------------------------------------

test('Enterprise with 30 minutes and 4 questions gets a 30-minute call limit and a 4-question rubric', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });

  const capacity = await capacityFor(db);
  assert.equal(capacity.max_interview_minutes, 30);
  assert.equal(capacity.interview_duration_minutes, 30);
  assert.equal(capacity.scored_question_count, 4);

  const role = await createRole(db, { id: 'role_new' });
  assert.equal(role.rubric_questions.length, 4, 'a 4-question rubric');
  assert.equal(role.rubric.scored_question_count, 4, 'stamped with the count it was generated for');
  assert.equal(role.rubric.max_interview_minutes, 30);

  const roleCapacity = await resolveRoleInterviewCapacity({ db, role, env: NO_SYNTHETIC });
  assert.equal(roleCapacity.max_interview_minutes, 30);
  assert.equal(resolveProviderMaxCallDurationSeconds(roleCapacity.max_interview_minutes),
    30 * 60 + PROVIDER_CLOSING_GRACE_SECONDS, 'the Tavus call limit is 30 minutes plus the closing grace');

  const prompt = buildRubricPrompt(role, 'JD', capacity.membership_level, capacity);
  assert.match(prompt, /Return exactly 4 scored questions/);
  assert.match(prompt, /Candidate-visible duration: 30 minutes/);
  assert.deepEqual(db.notNullViolations, []);
});

test('Enterprise with the default length and an empty question count gets 15 and 7', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 15, scored_question_count: null });

  const capacity = await capacityFor(db);
  assert.equal(capacity.max_interview_minutes, PLAN_CAPACITY.enterprise.max_interview_minutes);
  assert.equal(capacity.scored_question_count, PLAN_CAPACITY.enterprise.scored_question_count);
  assert.equal(capacity.max_interview_minutes, 15);
  assert.equal(capacity.scored_question_count, 7);

  const role = await createRole(db, { id: 'role_default' });
  assert.equal(role.rubric_questions.length, 7);
});

test('Pro with other values stored still gets 12 and 6', async () => {
  const db = makeDb({ plan_tier: 'pro', max_interview_minutes: 40, scored_question_count: 3 });

  const capacity = await capacityFor(db);
  assert.equal(capacity.max_interview_minutes, 12);
  assert.equal(capacity.scored_question_count, 6);

  const role = await createRole(db, { id: 'role_pro' });
  assert.equal(role.rubric_questions.length, 6);
  assert.equal((await resolveRoleInterviewCapacity({ db, role, env: NO_SYNTHETIC })).max_interview_minutes, 12);
});

test('Essentials with other values stored still gets 10 and 5', async () => {
  const db = makeDb({ plan_tier: 'basic', max_interview_minutes: 40, scored_question_count: 3 });

  const capacity = await capacityFor(db);
  assert.equal(capacity.max_interview_minutes, 10);
  assert.equal(capacity.scored_question_count, 5);
});

test('a child entity gets its parent\'s values', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });

  const capacity = await capacityFor(db, CHILD);
  assert.equal(capacity.max_interview_minutes, 30);
  assert.equal(capacity.scored_question_count, 4);

  const role = await createRole(db, { id: 'role_child', clientId: CHILD });
  assert.equal(role.rubric_questions.length, 4);
  assert.equal((await resolveRoleInterviewCapacity({ db, role, env: NO_SYNTHETIC })).max_interview_minutes, 30);
});

test('a stored value outside what an agreement may set falls back to the plan value', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 90, scored_question_count: 12 });

  const capacity = await capacityFor(db);
  assert.equal(capacity.max_interview_minutes, 15);
  assert.equal(capacity.scored_question_count, 7);
});

test('the internal synthetic client override works as before', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 3, scored_question_count: 4 });
  const env = { [INTERNAL_SYNTHETIC_CLIENT_IDS_ENV]: PARENT };

  const capacity = await capacityFor(db, PARENT, env);
  assert.equal(capacity.max_interview_minutes, 3, 'the configured duration, not clamped to an agreement\'s range');
  assert.equal(capacity.internal_synthetic_duration_override, true);

  // Live for its roles too, whatever their rubric says, as before.
  const role = { id: 'role_synthetic', client_id: PARENT, rubric: { membership_level: 'enterprise', max_interview_minutes: 30 } };
  assert.equal((await resolveRoleInterviewCapacity({ db, role, env })).max_interview_minutes, 3);
});

// --- an existing role keeps what it was created with ---------------------------------

test('an existing role is unaffected by a later change to the client\'s settings', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });
  const existing = await createRole(db, { id: 'role_existing' });

  setSettings(db, { max_interview_minutes: 45, scored_question_count: 6 });

  const existingCapacity = await resolveRoleInterviewCapacity({ db, role: existing, env: NO_SYNTHETIC });
  assert.equal(existingCapacity.max_interview_minutes, 30, 'the existing role keeps its length');
  assert.equal(existingCapacity.scored_question_count, 4);
  assert.equal(existing.rubric_questions.length, 4, 'and its rubric');

  const created = await createRole(db, { id: 'role_after' });
  assert.equal(created.rubric_questions.length, 6, 'a role created afterwards gets the new count');
  assert.equal((await resolveRoleInterviewCapacity({ db, role: created, env: NO_SYNTHETIC })).max_interview_minutes, 45);
});

test('a role from before stamping keeps its tier\'s plan values when the client changes', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });
  const legacy = {
    id: 'role_legacy', client_id: PARENT,
    rubric: { membership_level: 'enterprise', interview_type: 'core', questions: new Array(7).fill({ text: 'q' }) }
  };

  const capacity = await resolveRoleInterviewCapacity({ db, role: legacy, env: NO_SYNTHETIC });
  assert.equal(capacity.max_interview_minutes, 15, 'what every rubric was generated at before E4');
  assert.equal(capacity.scored_question_count, 7);
});

test('a role without a rubric yet follows the client', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });

  const capacity = await resolveRoleInterviewCapacity({ db, role: { id: 'role_bare', client_id: PARENT }, env: NO_SYNTHETIC });
  assert.equal(capacity.max_interview_minutes, 30);
});

test('the roles list resolves each client through the resolver and each role by its rubric', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'client', 'roles.js'), 'utf8');
  assert.doesNotMatch(source, /from\('client_plan_settings'\)/, 'no direct plan-settings read');
  assert.doesNotMatch(source, /resolvePlanCapacity\(/, 'no plan-row resolution that skips the billing owner');
  assert.match(source, /resolvePlanCapacityForClient\(\{ db, clientId: planClientId \}\)/);
  assert.match(source, /capacityForRole\(planCapacityByClientId\[role\.client_id\] \|\| null, role\.rubric\)/);

  // The rule the list applies per role, on a child entity's resolved capacity.
  const { capacityForRole } = require('../src/services/planCapacity');
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30, scored_question_count: 4 });
  const childCapacity = await capacityFor(db, CHILD);
  assert.equal(capacityForRole(childCapacity, null).max_interview_minutes, 30, 'no rubric yet: the client');
  assert.equal(capacityForRole(childCapacity, { max_interview_minutes: 20, scored_question_count: 3 }).max_interview_minutes, 20,
    'a stamped rubric: the role');
  assert.equal(capacityForRole(childCapacity, { membership_level: 'enterprise' }).max_interview_minutes, 15,
    'an unstamped rubric: its tier\'s plan value');
  assert.equal(capacityForRole(null, { max_interview_minutes: 20 }), null, 'an unresolved client stays unresolved');
});

test('a client whose plan cannot be read is still refused, as before', async () => {
  const db = makeDb({ plan_tier: 'enterprise', max_interview_minutes: 30 });
  db.tables.client_plan_settings.length = 0;

  await assert.rejects(
    resolveRoleInterviewCapacity({ db, role: { id: 'r', client_id: PARENT, rubric: { max_interview_minutes: 30 } }, env: NO_SYNTHETIC }),
    (error) => error.code === 'INVALID_MEMBERSHIP_LEVEL'
  );
});
