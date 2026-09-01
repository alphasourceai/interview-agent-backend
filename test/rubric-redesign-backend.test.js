'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'rubric-redesign-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'rubric-redesign-anon-key';
process.env.OPENAI_API_KEY ||= 'rubric-redesign-openai-key';

const {
  INTERNAL_SYNTHETIC_CLIENT_IDS_ENV,
  getPlanCapacity,
  normalizeMembershipLevel,
  resolvePlanCapacity,
} = require('../src/lib/planCapacity');
const {
  CANONICAL_INTERVIEW_TYPES,
  getInterviewTypeConfig,
  normalizeInterviewType,
  normalizeRoleInterviewTypeForRead,
} = require('../src/lib/interviewTypes');
const {
  GENERIC_FILLER_PATTERNS,
  PROHIBITED_QUESTION_PATTERNS,
  buildFallbackRubric,
  buildRubricPrompt,
  resolveMembershipLevelForRole,
  validateRubric,
} = require('../generateRubric');
const {
  buildCustomGreeting,
  buildConversationalContext,
} = require('../handlers/createTavusInterview');
const {
  INTRODUCTION_BODY,
  WARMUP_QUESTION,
  WARMUP_TRANSITION,
  excludeWarmupFromTranscript,
  excludeWarmupFromTranscriptItems,
  prepareEvaluativeTranscript,
} = require('../src/lib/warmupExclusion');
const {
  classifyTranscriptCandidateEvidence,
} = require('../src/lib/interviewUtteranceClassifier');
const {
  isSubstantiveTranscript,
  scoreInterview,
} = require('../src/lib/interviewScoring');
const {
  buildInterviewAnalysisV2Prompt,
} = require('../src/lib/interviewAnalysisV2');
const {
  PROVIDER_CLOSING_GRACE_SECONDS,
  resolveProviderMaxCallDurationSeconds,
} = require('../src/lib/interviewDuration');
const { extractCandidateQuestions } = require('../src/lib/unansweredCandidateQuestions');

const ROOT = path.join(__dirname, '..');
const PLAN_EXPECTATIONS = Object.freeze({
  basic: Object.freeze({ minutes: 10, questions: 5 }),
  pro: Object.freeze({ minutes: 12, questions: 6 }),
  enterprise: Object.freeze({ minutes: 15, questions: 7 }),
});
const TYPE_ROLES = Object.freeze({
  core: Object.freeze({ title: 'Customer Service Representative', description: 'Resolve customer needs accurately and collaborate with operations.' }),
  leadership: Object.freeze({ title: 'Regional Operations Manager', description: 'Coach managers, improve performance, and lead cross-functional execution.' }),
  technical: Object.freeze({ title: 'Full-Stack Engineer', description: 'Design, implement, test, troubleshoot, and operate full-stack systems.' }),
});

function occurrences(value, search) {
  return String(value).split(search).length - 1;
}

function transcriptWithWarmup(scoredAnswer = 'I led a migration and used SQL validation to reduce processing failures by 40 percent.') {
  return [
    `INTERVIEWER: Hi, Ada. ${INTRODUCTION_BODY} ${WARMUP_QUESTION}`,
    'CANDIDATE: Winter is my favorite because a medical treatment makes hot weather difficult.',
    `INTERVIEWER: ${WARMUP_TRANSITION} Describe a concrete project you owned.`,
    `CANDIDATE: ${scoredAnswer}`,
  ].join('\n');
}

test('plan capacity is exact, membership-owned, type-independent, and preserves Essential membership', () => {
  assert.equal(normalizeMembershipLevel('essential'), 'basic');
  assert.equal(normalizeMembershipLevel('Basic'), 'basic');

  for (const [membershipLevel, expected] of Object.entries(PLAN_EXPECTATIONS)) {
    const capacity = getPlanCapacity(membershipLevel);
    assert.equal(capacity.membership_level, membershipLevel);
    assert.equal(capacity.display_name, membershipLevel === 'basic' ? 'Essential' : membershipLevel === 'pro' ? 'Pro' : 'Enterprise');
    assert.equal(capacity.interview_duration_minutes, expected.minutes);
    assert.equal(capacity.max_interview_minutes, expected.minutes);
    assert.equal(capacity.scored_question_count, expected.questions);

    for (const interviewType of CANONICAL_INTERVIEW_TYPES) {
      const rubric = buildFallbackRubric({ ...TYPE_ROLES[interviewType], interview_type: interviewType }, membershipLevel);
      assert.equal(rubric.questions.length, expected.questions, `${membershipLevel} + ${interviewType}`);
      assert.equal(getPlanCapacity(membershipLevel).max_interview_minutes, expected.minutes);
    }
  }

  assert.notEqual(getPlanCapacity('basic').scored_question_count, getPlanCapacity('pro').scored_question_count);
  assert.notEqual(getPlanCapacity('pro').max_interview_minutes, getPlanCapacity('enterprise').max_interview_minutes);
});

test('internal synthetic duration override is explicit and isolated from external clients', () => {
  const env = { [INTERNAL_SYNTHETIC_CLIENT_IDS_ENV]: 'synthetic-client,another-synthetic-client' };
  const external = resolvePlanCapacity({
    planTier: 'basic',
    clientId: 'external-client',
    configuredDurationMinutes: 3,
    env,
  });
  assert.equal(external.max_interview_minutes, 10);
  assert.equal(external.internal_synthetic_duration_override, undefined);

  const internal = resolvePlanCapacity({
    planTier: 'basic',
    clientId: 'synthetic-client',
    configuredDurationMinutes: 3,
    env,
  });
  assert.equal(internal.max_interview_minutes, 3);
  assert.equal(internal.scored_question_count, 5);
  assert.equal(internal.internal_synthetic_duration_override, true);

  assert.throws(
    () => resolvePlanCapacity({ planTier: 'basic', clientId: 'synthetic-client', configuredDurationMinutes: 60, env }),
    (error) => error?.code === 'INVALID_INTERNAL_SYNTHETIC_DURATION',
  );
});

test('legacy interview types normalize on read while canonical values remain the only new output values', () => {
  assert.equal(normalizeInterviewType('basic'), 'core');
  assert.equal(normalizeInterviewType('DETAILED'), 'leadership');
  assert.equal(normalizeInterviewType('technical'), 'technical');
  assert.equal(normalizeInterviewType('core'), 'core');
  assert.equal(normalizeRoleInterviewTypeForRead({ id: 'legacy', interview_type: 'DETAILED' }).interview_type, 'leadership');
  assert.equal(normalizeRoleInterviewTypeForRead({ id: 'missing', interview_type: null }).interview_type, 'core');
  assert.equal(normalizeInterviewType('unknown'), null);
});

test('interview-type configuration owns content but contains no duration, count, or eligibility fields', () => {
  for (const interviewType of CANONICAL_INTERVIEW_TYPES) {
    const config = getInterviewTypeConfig(interviewType);
    assert.equal(config.canonical_name, interviewType);
    assert.equal(config.blueprint.length, 7);
    assert.ok(config.purpose.length > 40);
    assert.ok(config.scoring_emphasis.length >= 5);
    for (const forbidden of ['duration', 'minutes', 'question_count', 'scored_question_count', 'membership', 'eligibility']) {
      assert.equal(Object.hasOwn(config, forbidden), false, `${interviewType}.${forbidden}`);
    }
  }
});

test('rubric generation resolves child-entity membership through the parent billing owner', async () => {
  const clients = {
    child: { id: 'child', parent_client_id: 'parent' },
    parent: { id: 'parent', parent_client_id: null },
  };
  const plans = {
    parent: { client_id: 'parent', plan_tier: 'pro' },
  };
  const db = {
    from(table) {
      let id = '';
      return {
        select() { return this; },
        eq(column, value) {
          if (column === 'id' || column === 'client_id') id = String(value);
          return this;
        },
        async maybeSingle() {
          return {
            data: table === 'clients' ? (clients[id] || null) : (plans[id] || null),
            error: null,
          };
        },
      };
    },
  };

  assert.equal(
    await resolveMembershipLevelForRole({ client_id: 'child' }, { supabaseClient: db }),
    'pro',
  );
});

test('nine-combination isolated quality matrix satisfies quantity, competency, metadata, relevance, and compliance', () => {
  for (const [membershipLevel, expected] of Object.entries(PLAN_EXPECTATIONS)) {
    for (const interviewType of CANONICAL_INTERVIEW_TYPES) {
      const role = { ...TYPE_ROLES[interviewType], interview_type: interviewType };
      const rubric = buildFallbackRubric(role, membershipLevel);
      const validation = validateRubric(rubric, { membershipLevel, interviewType });
      const blueprint = getInterviewTypeConfig(interviewType).blueprint.slice(0, expected.questions);
      const competencies = rubric.questions.map((question) => question.primary_competency);

      assert.equal(getPlanCapacity(membershipLevel).max_interview_minutes, expected.minutes);
      assert.equal(rubric.questions.length, expected.questions);
      assert.equal(validation.ok, true, `${membershipLevel} + ${interviewType}: ${validation.errors.join(', ')}`);
      assert.deepEqual(competencies, blueprint.map((item) => item.primary_competency));
      assert.equal(new Set(competencies.map((value) => value.toLowerCase())).size, expected.questions);

      for (const [index, question] of rubric.questions.entries()) {
        assert.equal(question.question_order, index + 1);
        assert.ok(question.text.includes(role.title) || question.role_relevance.includes(role.title));
        assert.ok(question.why_it_matters.length > 20);
        assert.ok(question.expected_evidence.length > 20);
        assert.ok(question.role_relevance.length > 20);
        assert.deepEqual(Object.keys(question.scoring_guidance), ['weak', 'adequate', 'strong', 'exceptional']);
        assert.equal(GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(question.text)), false);
        assert.equal(PROHIBITED_QUESTION_PATTERNS.some((pattern) => pattern.test(question.text)), false);
      }

      const prompt = buildRubricPrompt(role, role.description, membershipLevel);
      assert.match(prompt, new RegExp(`exactly ${expected.questions} scored questions`, 'i'));
      assert.match(prompt, new RegExp(`Canonical type: ${interviewType}`, 'i'));
      assert.match(prompt, /warm-up is not part of this rubric/i);
    }
  }
});

test('deterministic rubric quality validation rejects every specified failure class', () => {
  const role = { ...TYPE_ROLES.core, interview_type: 'core' };
  const valid = buildFallbackRubric(role, 'basic');

  const wrongCount = { ...valid, questions: valid.questions.slice(0, 4) };
  assert.match(validateRubric(wrongCount, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /wrong_question_count/);

  const duplicate = structuredClone(valid);
  duplicate.questions[1].primary_competency = duplicate.questions[0].primary_competency;
  duplicate.questions[1].category = duplicate.questions[0].category;
  assert.match(validateRubric(duplicate, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /duplicate_competency/);

  const missingMetadata = structuredClone(valid);
  missingMetadata.questions[0].expected_evidence = '';
  missingMetadata.questions[0].scoring_guidance.strong = '';
  assert.match(validateRubric(missingMetadata, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /missing_expected_evidence/);
  assert.match(validateRubric(missingMetadata, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /missing_scoring_strong/);

  const legacyType = { ...valid, interview_type: 'basic' };
  assert.match(validateRubric(legacyType, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /noncanonical_interview_type/);

  const filler = structuredClone(valid);
  filler.questions[0].text = 'Tell me about yourself.';
  assert.match(validateRubric(filler, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /generic_filler/);

  const protectedQuestion = structuredClone(valid);
  protectedQuestion.questions[0].text = 'Do you have a medical condition or disability?';
  assert.match(validateRubric(protectedQuestion, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /prohibited_content/);

  const wrongTypeEmphasis = structuredClone(valid);
  wrongTypeEmphasis.questions[0].primary_competency = 'leadership scope and results';
  assert.match(validateRubric(wrongTypeEmphasis, { membershipLevel: 'basic', interviewType: 'core' }).errors.join('|'), /wrong_type_competency/);
});

test('approved introduction, fallback, warm-up, transition, and question ordering are exact', () => {
  const namedGreeting = buildCustomGreeting('Ada Lovelace');
  const fallbackGreeting = buildCustomGreeting('');
  assert.equal(namedGreeting, `Hi, Ada. ${INTRODUCTION_BODY} ${WARMUP_QUESTION}`);
  assert.equal(fallbackGreeting, `Hi there. ${INTRODUCTION_BODY} ${WARMUP_QUESTION}`);
  assert.equal(occurrences(namedGreeting, WARMUP_QUESTION), 1);
  assert.doesNotMatch(namedGreeting, /I hope your day is going well|Thanks for joining me today|Let’s start with the first question/i);

  const context = buildConversationalContext(
    'Ada',
    'Operations Coordinator',
    'Example Company',
    ['Describe a time you improved an operational process.'],
    '',
    10,
  );
  assert.equal(occurrences(context, WARMUP_TRANSITION), 1);
  assert.ok(context.indexOf(WARMUP_TRANSITION) < context.indexOf('Structured Interview Questions:'));
  assert.match(context, /Do not ask a warm-up follow-up/);
  assert.match(context, /Then ask structured interview question 1/);
});

test('warm-up is excluded from substantive evidence, scores, summaries, Analysis V2, and sensitive-content use', async () => {
  const transcript = transcriptWithWarmup();
  const evaluative = prepareEvaluativeTranscript(transcript);
  assert.equal(evaluative.warmup_detected, true);
  assert.equal(evaluative.warmup_excluded, true);
  assert.doesNotMatch(evaluative.transcript, /favorite season|Winter|medical treatment/i);
  assert.match(evaluative.transcript, /Describe a concrete project|led a migration/i);
  assert.equal(excludeWarmupFromTranscript(transcript), evaluative.transcript);

  const warmupOnly = [
    `INTERVIEWER: Hi there. ${INTRODUCTION_BODY} ${WARMUP_QUESTION}`,
    'CANDIDATE: I used Python to track every winter storm for my medical treatment schedule.',
    `INTERVIEWER: ${WARMUP_TRANSITION}`,
  ].join('\n');
  assert.equal(classifyTranscriptCandidateEvidence(warmupOnly).ok, false);
  assert.equal(isSubstantiveTranscript(warmupOnly).ok, false);
  assert.equal(classifyTranscriptCandidateEvidence(transcript).substantiveResponseCount, 1);

  const analysisPrompt = buildInterviewAnalysisV2Prompt({ transcript });
  assert.doesNotMatch(analysisPrompt, /Winter|medical treatment|favorite season/i);
  assert.match(analysisPrompt, /led a migration/i);
  assert.match(analysisPrompt, /warm-up and its response are unscored/i);

  const originalFetch = global.fetch;
  let scoringRequest = null;
  global.fetch = async (_url, options) => {
    scoringRequest = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({
            summary: 'The candidate gave concrete, role-relevant evidence.',
            overall: 80,
            role_fit: 81,
            technical_strength: 79,
            communication_quality: 82,
            evidence_strength: 78,
            ai_aided_risk: 'low',
            ai_aided_risk_reason: 'No strong scripted-delivery indicators were present.',
            ai_aided_signals: [],
          }) } }],
        };
      },
    };
  };
  try {
    const scored = await scoreInterview({ transcriptText: transcript, jdText: TYPE_ROLES.technical.description });
    const prompt = scoringRequest.messages[1].content;
    assert.doesNotMatch(prompt, /Winter|medical treatment|favorite season/i);
    assert.match(prompt, /led a migration/i);
    assert.match(prompt, /warm-up and its response are unscored/i);
    assert.doesNotMatch(scored.summary, /Winter|medical treatment|favorite season/i);
    assert.equal(scored.transcript_scores.overall, 80);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unlabelled warm-up transcripts tolerate provider punctuation variants without leaking warm-up content', () => {
  const variants = [
    "Thanks for sharing! Let's begin.",
    'Thanks for sharing — Lets begin!',
    'Thanks for sharing? Let us begin.',
  ];

  for (const transition of variants) {
    const raw = `INTERVIEWER: ${WARMUP_QUESTION} CANDIDATE: Winter because of a medical treatment. INTERVIEWER: ${transition} Describe a project. CANDIDATE: I led a migration.`;
    const evaluative = prepareEvaluativeTranscript(raw);
    assert.equal(evaluative.warmup_detected, true);
    assert.equal(evaluative.warmup_excluded, true);
    assert.doesNotMatch(evaluative.transcript, /Winter|medical treatment|favorite season/i);
    assert.match(evaluative.transcript, /Describe a project|led a migration/i);
  }

  const unbounded = `INTERVIEWER: ${WARMUP_QUESTION} CANDIDATE: Winter because of a medical treatment.`;
  assert.equal(prepareEvaluativeTranscript(unbounded).transcript, '');
});

test('reports, recommendations, comparisons, and reconciliation consume sanitized derived evidence rather than raw warm-up text', () => {
  const reportsSource = fs.readFileSync(path.join(ROOT, 'routes', 'reportsPdf.js'), 'utf8');
  const automationSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'candidateAutomationEvaluator.js'), 'utf8');
  const reconciliationSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'finalTranscriptReconciliation.js'), 'utf8');
  assert.doesNotMatch(reportsSource, /latestInterview\??\.transcript(?!_scores)/);
  assert.doesNotMatch(automationSource, /interviewRow\??\.transcript(?!_scores)/);
  assert.doesNotMatch(reconciliationSource, /favorite season/i);
  assert.match(automationSource, /transcript_scores/);
  assert.match(reportsSource, /transcript_scores/);

  const items = [
    { role: 'replica', content: `Hi there. ${INTRODUCTION_BODY} ${WARMUP_QUESTION}` },
    { role: 'candidate', content: 'Winter. Also, [[UNANSWERED_QUESTION: Did my medical answer count?]]' },
    { role: 'replica', content: `${WARMUP_TRANSITION} Describe a project you owned.` },
    { role: 'candidate', content: 'I led a migration. [[UNANSWERED_QUESTION: What happens next?]]' },
  ];
  const evaluativeItems = excludeWarmupFromTranscriptItems(items);
  assert.equal(evaluativeItems.length, 2);
  assert.deepEqual(extractCandidateQuestions(evaluativeItems), ['What happens next?']);
});

test('the provider-only terminal-closing grace remains exactly 20 seconds', () => {
  assert.equal(PROVIDER_CLOSING_GRACE_SECONDS, 20);
  assert.equal(resolveProviderMaxCallDurationSeconds(10), 620);
  assert.equal(resolveProviderMaxCallDurationSeconds(12), 740);
  assert.equal(resolveProviderMaxCallDurationSeconds(15), 920);
});
