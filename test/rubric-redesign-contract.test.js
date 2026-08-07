'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('red contract: membership owns one authoritative exact duration and question-count map', () => {
  const planCapacityPath = path.join(ROOT, 'src', 'lib', 'planCapacity.js');
  assert.equal(fs.existsSync(planCapacityPath), true, 'authoritative plan-capacity module is missing');
  const text = fs.readFileSync(planCapacityPath, 'utf8');
  assert.match(text, /basic[\s\S]*10[\s\S]*5/i);
  assert.match(text, /pro[\s\S]*12[\s\S]*6/i);
  assert.match(text, /enterprise[\s\S]*15[\s\S]*7/i);
});

test('red contract: rubric quantity is not derived from legacy interview type', () => {
  const text = source('generateRubric.js');
  assert.doesNotMatch(text, /RUBRIC_TARGET_MINIMUMS/);
  assert.doesNotMatch(text, /replacementRubricTargetCount\(interviewType\)/);
  assert.match(text, /planCapacity|plan_capacity|scoredQuestionCount/);
});

test('red contract: the fixed non-work warm-up replaces the legacy immediate scored opening', () => {
  const text = [source('handlers/createTavusInterview.js'), source('src/lib/warmupExclusion.js')].join('\n');
  assert.match(text, /Speaking with an AI can feel a little different at first/);
  assert.match(text, /favorite season/);
  assert.match(text, /Thanks for sharing\. Let[’']s begin\./);
  assert.doesNotMatch(text, /I hope your day is going well/);
  assert.doesNotMatch(text, /ask the first structured interview question immediately/);
});

test('red contract: warm-up evidence has a shared downstream exclusion boundary', () => {
  const exclusionPath = path.join(ROOT, 'src', 'lib', 'warmupExclusion.js');
  assert.equal(fs.existsSync(exclusionPath), true, 'shared warm-up exclusion module is missing');
  const scoring = source('src/lib/interviewScoring.js');
  const analysis = source('src/lib/interviewAnalysisV2.js');
  const classifier = source('src/lib/interviewUtteranceClassifier.js');
  assert.match(scoring, /excludeWarmup|stripWarmup/);
  assert.match(analysis, /excludeWarmup|stripWarmup/);
  assert.match(classifier, /excludeWarmup|stripWarmup/);
});

test('red contract: canonical types and legacy aliases are application-normalized', () => {
  const typePath = path.join(ROOT, 'src', 'lib', 'interviewTypes.js');
  assert.equal(fs.existsSync(typePath), true, 'canonical interview-type module is missing');
  const text = fs.readFileSync(typePath, 'utf8');
  assert.match(text, /basic[\s\S]*core/i);
  assert.match(text, /detailed[\s\S]*leadership/i);
  assert.match(text, /technical/);
});

test('red contract: new role writes no longer persist legacy interview-type values', () => {
  const roleWrites = [
    source('src/lib/rolePurchaseFinalizer.js'),
    source('routes/roles.js'),
    source('app.js'),
  ].join('\n');
  assert.doesNotMatch(roleWrites, /new Set\(\['BASIC',\s*'DETAILED',\s*'TECHNICAL'\]\)/);
  assert.doesNotMatch(roleWrites, /\['BASIC',\s*'DETAILED',\s*'TECHNICAL'\]\.includes/);
  assert.match(roleWrites, /normalizeInterviewType/);
});
