'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

const SYNTHETIC_INTERVIEW_ID = '11111111-1111-4111-8111-111111111111';

async function captureConversationPayload(maxInterviewMinutes = 10) {
  const originalPost = axios.post;
  const previousEnv = {
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    TAVUS_API_KEY: process.env.TAVUS_API_KEY,
    TAVUS_PERSONA_ID: process.env.TAVUS_PERSONA_ID,
    TAVUS_REPLICA_ID: process.env.TAVUS_REPLICA_ID,
  };
  let payload = null;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'synthetic-anon-key';
  process.env.TAVUS_API_KEY = 'synthetic-test-key';
  process.env.TAVUS_PERSONA_ID = 'synthetic-test-persona';
  process.env.TAVUS_REPLICA_ID = 'synthetic-test-replica';
  axios.post = async (_url, body) => {
    payload = body;
    return {
      data: {
        conversation_id: 'synthetic-conversation',
        conversation_url: 'https://example.invalid/synthetic-conversation',
      },
    };
  };

  try {
    const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');
    await createTavusInterviewHandler(
      { id: 'synthetic-candidate', name: 'Synthetic Candidate' },
      {
        id: 'synthetic-role',
        title: 'Synthetic Role',
        tavus_document_id: 'synthetic-document',
        rubric_questions: ['Describe a synthetic project?'],
      },
      'https://example.invalid/webhook',
      {
        companyName: 'Synthetic Company',
        interviewId: SYNTHETIC_INTERVIEW_ID,
        maxInterviewMinutes,
      },
    );
    return payload;
  } finally {
    axios.post = originalPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('conversation context treats runtime timing state as private behavior control', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /runtime closing control state/i);
  assert.match(context, /never (?:quote|mention|summarize|paraphrase|reveal)/i);
  assert.match(context, /two-minute and one-minute browser warnings are visual-only/i);
  assert.doesNotMatch(context, /briefly acknowledge that time is running low/i);
  assert.doesNotMatch(context, /If the system or front-end sends a time warning/i);
});

test('question lock overrides rubric coverage, follow-ups, and question-count goals', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /QUESTION_LOCKED/);
  assert.match(context, /do not begin another rubric, follow-up, clarification, or assessment question/i);
  assert.match(context, /overrides remaining rubric coverage, follow-up requirements, and question-count goals/i);
});

test('application owns the candidate-question invitation and no acknowledgment is required', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /application deterministically owns the final candidate-question invitation/i);
  assert.match(context, /Never create or repeat that invitation independently/i);
  assert.match(context, /answer at most one direct candidate question/i);
  assert.match(context, /do not require (?:a )?candidate acknowledgment/i);
  assert.doesNotMatch(context, /Do you have any questions for me before we wrap up\?/i);
  assert.doesNotMatch(context, /Any other questions\? If not, just say 'no'\./i);
});

test('closing and termination states yield to the application-owned end path', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /CLOSING_ONLY/);
  assert.match(context, /application owns that invitation/i);
  assert.match(context, /TERMINATION_ONLY/);
  assert.match(context, /application farewell and end-conversation backstop/i);
});

test('provider duration remains an independent hard upper bound', async () => {
  const payload = await captureConversationPayload();

  assert.equal(payload?.properties?.max_call_duration, 600);
  assert.equal(payload?.properties?.participant_left_timeout, 60);
});

test('provider handler fails closed before Tavus when duration is invalid', async () => {
  await assert.rejects(
    () => captureConversationPayload(null),
    (error) => error?.code === 'INTERVIEW_DURATION_NOT_CONFIGURED',
  );
});
