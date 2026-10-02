'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const {
  SALES_VOICE_CONTEXT_TOOL,
  SALES_VOICE_TOOL,
  buildSalesVoiceBootstrapPrompt,
  buildSalesVoiceAgentPrompt,
  createSalesVoiceHandoff,
  createSalesVoiceHandoffRouter,
  parseRouteConfig,
  routeForAuthorization,
  routeForAuthorizationDb,
  salesVoiceHandoffEnabled,
  salesVoiceDatabaseRoutesEnabled,
  salesVoiceProviderEnabled,
  validateSalesVoiceMessage,
  voiceContext,
} = require('../src/lib/salesVoiceHandoff');

const TOKEN = 'm'.repeat(48);
const route = {
  route_key: 'sales-qa-rep',
  token_sha256: crypto.createHash('sha256').update(TOKEN).digest('hex'),
  rep_name: 'Sales QA Rep',
  rep_email: 'sales.qa@example.invalid',
  slack_user_id: 'U123456789',
  ghl_number: '+17207904187',
  ghl_notification_webhook: 'https://services.leadconnectorhq.com/hooks/example'
};
const env = {
  SALES_VOICE_HANDOFF_ENABLED: 'true',
  SALES_VOICE_FROM_EMAIL: 'sales-agent@alphasourceai.com',
  SENDGRID_API_KEY: 'SG.' + 'a'.repeat(40),
  SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 'b'.repeat(40),
  SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([route])
};
const message = {
  caller_name: 'Jordan Lee',
  company_name: 'Northstar Dental',
  callback_phone: '+17205551212',
  contact_email: 'jordan@example.com',
  message: 'Please call me about an alphaScreen Pro membership.',
  confirmed: true
};

test('validates exact caller-approved fields', () => {
  assert.deepEqual(validateSalesVoiceMessage(message), message);
  assert.equal(validateSalesVoiceMessage({ ...message, confirmed: false }), null);
  for (const phone of ['720-555-1212', '(720) 555-1212', '1 720.555.1212', '+1 (720) 555-1212']) {
    assert.equal(validateSalesVoiceMessage({ ...message, callback_phone: phone }).callback_phone, '+17205551212');
  }
  for (const phone of ['+7205551212', '7205551212 ext 9', '7205551212#9', '7205551212,3035551111', '72055512123', '２０２５５５１２１２', '720/555/1212', '+1+7205551212']) {
    assert.equal(validateSalesVoiceMessage({ ...message, callback_phone: phone }), null);
  }
  assert.equal(validateSalesVoiceMessage({ ...message, contact_email: 'not-an-email' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, password: 'nope' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, to: 'other@example.com' }), null);
  assert.equal(validateSalesVoiceMessage({ ...message, message: 'Use code 123456' }), null);
  const shared = { ...message, routing_reference: 'r'.repeat(48) };
  assert.deepEqual(validateSalesVoiceMessage(shared), shared);
  assert.equal(validateSalesVoiceMessage({ ...shared, routing_reference: 'spoken routing reference' }), null);
  assert.deepEqual(SALES_VOICE_CONTEXT_TOOL.parameters.required, ['caller_phone']);
  assert.ok(SALES_VOICE_TOOL.parameters.required.includes('routing_reference'));
});

test('requires complete fixed routes and matches bearer token without a caller-selected recipient', () => {
  assert.equal(salesVoiceHandoffEnabled(env), true);
  assert.equal(parseRouteConfig(env)[0].repName, 'Sales QA Rep');
  assert.equal(routeForAuthorization(`Bearer ${TOKEN}`, env).routeKey, 'sales-qa-rep');
  assert.equal(routeForAuthorization(`Bearer ${'z'.repeat(48)}`, env), null);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route, ghl_notification_webhook: 'https://example.com/hook' }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route, rep_email: undefined }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route }, { ...route, token_sha256: 'f'.repeat(64) }]) }).length, 0);
  assert.equal(parseRouteConfig({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: JSON.stringify([{ ...route }, { ...route, route_key: 'second-route', token_sha256: 'f'.repeat(64) }]) }).length, 0);
  assert.equal(salesVoiceHandoffEnabled({ ...env, SALES_VOICE_HANDOFF_ENABLED: 'false' }), false);
  assert.equal(salesVoiceProviderEnabled({ ...env, SALES_VOICE_HANDOFF_ROUTES_JSON: undefined }), true);
  assert.equal(salesVoiceDatabaseRoutesEnabled(env), false);
  assert.equal(salesVoiceDatabaseRoutesEnabled({ ...env, SALES_VOICE_DB_ROUTES_ENABLED: 'true' }), true);
});

test('database-managed route resolves a token to fixed active recipients', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-1', team_member_id: 'member-1', phone_number_id: 'phone-1', handoff_token_sha256: digest, status: 'active' }],
    sales_team_members: [{ id: 'member-1', display_name: 'Sales QA Rep', workspace_email: 'sales.qa@example.invalid', slack_user_id: 'U123456789', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-1', notify_email: true, notify_slack: true, notify_sms: true, status: 'applied', is_current: true }],
  };
  const db = {
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async maybeSingle() {
          const data = tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null;
          return { data, error: null };
        },
      };
    },
  };
  const dynamicEnv = {
    ...env,
    SALES_VOICE_HANDOFF_ROUTES_JSON: '[]',
    SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/sales-qa' }),
  };
  const resolved = await routeForAuthorizationDb(`Bearer ${TOKEN}`, db, dynamicEnv);
  assert.equal(resolved.repEmail, 'sales.qa@example.invalid');
  assert.equal(resolved.ghlNumber, '+17207904187');
  tables.sales_voice_configs[0].notify_sms = false;
  const emailSlackRoute = await routeForAuthorizationDb(`Bearer ${TOKEN}`, db, { ...dynamicEnv, SALES_VOICE_GHL_WEBHOOKS_JSON: '{}' });
  assert.equal(emailSlackRoute.notifySms, false);
  assert.equal(emailSlackRoute.ghlNotificationWebhook, '');
  assert.equal(await routeForAuthorizationDb(`Bearer ${'z'.repeat(48)}`, db, dynamicEnv), null);
});

test('stable company-line token follows the current active assignment and returns runtime context', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-2', team_member_id: 'member-2', phone_number_id: 'phone-1', status: 'active', transfer_enabled: false }],
    sales_team_members: [{ id: 'member-2', display_name: 'New Representative', workspace_email: 'new.rep@example.com', slack_user_id: 'U987654321', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', handoff_token_sha256: digest, active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-2', notify_email: true, notify_slack: true, notify_sms: true, greeting_override: 'Thanks for calling alphaScreen.', approved_context: 'Essential and Pro are available.', timezone: 'America/Denver', business_hours: { summary: 'Weekdays' }, answer_approved_faqs: true, schedule_demos: true, status: 'applied', is_current: true }],
  };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  const resolved = await routeForAuthorizationDb(`Bearer ${TOKEN}`, db, {
    ...env,
    SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/line-1' }),
  });
  assert.equal(resolved.repName, 'New Representative');
  assert.deepEqual(voiceContext(resolved), {
    status: 'ready', representative_name: 'New Representative', opening: 'Thanks for calling alphaScreen.', timezone: 'America/Denver',
    business_hours: { summary: 'Weekdays' }, approved_product_context: 'Essential and Pro are available.',
    capabilities: { answer_approved_faqs: true, schedule_demos: true, live_transfer: false },
  });
});

test('database routing takes precedence over an obsolete environment route for the same line token', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-current', team_member_id: 'member-current', phone_number_id: 'phone-1', status: 'active', transfer_enabled: false }],
    sales_team_members: [{ id: 'member-current', display_name: 'Current Representative', workspace_email: 'current@example.com', slack_user_id: 'U987654321', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', handoff_token_sha256: digest, active: true }],
    sales_voice_configs: [{ assignment_id: 'assignment-current', notify_email: true, notify_slack: true, notify_sms: true, status: 'applied', is_current: true }],
  };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    env: {
      ...env,
      SALES_VOICE_DB_ROUTES_ENABLED: 'true',
      SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://services.leadconnectorhq.com/hooks/current' }),
    },
    service: { enabled: () => true, send: async () => ({ status: 'accepted' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff/context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).representative_name, 'Current Representative');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a known database line fails closed instead of falling back to an obsolete environment recipient', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [],
    sales_team_members: [],
    sales_phone_numbers: [{ id: 'phone-1', e164: '+17207904187', handoff_token_sha256: digest, active: true }],
    sales_voice_configs: [],
  };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  let sends = 0;
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    env: { ...env, SALES_VOICE_DB_ROUTES_ENABLED: 'true' },
    service: { enabled: () => true, send: async () => { sends += 1; return { status: 'accepted' }; } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff/context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 503);
    assert.equal(sends, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a database lookup error fails closed even when the environment contains the same token', async () => {
  const db = { from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: { message: 'synthetic database failure' } }; } }; } };
  let sends = 0;
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    env: { ...env, SALES_VOICE_DB_ROUTES_ENABLED: 'true' },
    service: { enabled: () => true, send: async () => { sends += 1; return { status: 'accepted' }; } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff/context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 503);
    assert.equal(sends, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the compatibility environment route remains available only when the token is absent from the database', async () => {
  const tables = { sales_phone_numbers: [], sales_phone_assignments: [] };
  const db = { from(table) { const filters = []; return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } }; } };
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    env: { ...env, SALES_VOICE_DB_ROUTES_ENABLED: 'true' },
    service: { enabled: () => true, send: async () => ({ status: 'accepted' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff/context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).representative_name, 'Sales QA Rep');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('shared Grok entrypoint records a line, creates one context, and sends only to that assignment', async () => {
  const digest = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const tables = {
    sales_phone_assignments: [{ id: 'assignment-shared', team_member_id: 'member-shared', phone_number_id: 'phone-2', status: 'active', transfer_enabled: false }],
    sales_team_members: [{ id: 'member-shared', display_name: 'Shared QA Rep', workspace_email: 'shared.qa@example.invalid', slack_user_id: 'U987654321', status: 'active' }],
    sales_phone_numbers: [
      { id: 'phone-shared', e164: '+17125300281', handoff_token_sha256: digest, active: true, shared_voice_entrypoint: true },
      { id: 'phone-2', e164: '+17198818074', active: true, shared_voice_entrypoint: false },
    ],
    sales_voice_configs: [{ assignment_id: 'assignment-shared', notify_email: true, notify_slack: true, notify_sms: true, greeting_override: 'You reached the Shared QA Rep’s alphaScreen line.', approved_context: 'Essential and Pro.', timezone: 'America/Denver', business_hours: {}, answer_approved_faqs: true, schedule_demos: true, status: 'applied', is_current: true }],
  };
  let contextHash = '';
  let claimed = false;
  let contextFailure = null;
  const db = {
    from(table) {
      const filters = [];
      return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; }, async maybeSingle() { return { data: tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null, error: null }; } };
    },
    async rpc(name, args) {
      if (name === 'record_sales_voice_route') return { data: 'event-1', error: null };
      if (name === 'create_sales_voice_call_context' && contextFailure) return { data: null, error: contextFailure };
      if (name === 'create_sales_voice_call_context') { contextHash = args.p_token_sha256; claimed = false; return { data: [{ assignment_id: 'assignment-shared' }], error: null }; }
      if (name === 'claim_sales_voice_call_context' && !claimed && args.p_token_sha256 === contextHash) { claimed = true; return { data: [{ assignment_id: 'assignment-shared', caller_phone_e164: '+17205551212' }], error: null }; }
      return { data: [], error: null };
    },
  };
  const sends = [];
  const diagnostics = [];
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    db,
    logger: { warn: (...parts) => diagnostics.push(parts) },
    env: {
      ...env,
      SALES_VOICE_DB_ROUTES_ENABLED: 'true',
      SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17198818074': 'https://services.leadconnectorhq.com/hooks/line-2' }),
    },
    service: { enabled: () => true, send: async (input, resolved) => { sends.push({ input, resolved }); return { status: 'accepted' }; } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/voice-handoff`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${base}/route`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '720-555-1212' }) })).status, 400);
    const registered = await fetch(`${base}/route`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '+17205551212' }) });
    assert.equal(registered.status, 200);
    assert.equal((await fetch(`${base}/context`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '720-555-1212' }) })).status, 400);
    const contextResponse = await fetch(`${base}/context`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '+17205551212' }) });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.representative_name, 'Shared QA Rep');
    assert.match(context.routing_reference, /^[A-Za-z0-9_-]{48}$/);
    const approved = { ...message, callback_phone: '(720) 555-1212', routing_reference: context.routing_reference };
    const invalid = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...approved, callback_phone: '720-555-1212 ext 9' }) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { status: 'invalid_request', reason: 'invalid_phone_format' });
    assert.equal(claimed, false);
    assert.equal(sends.length, 0);
    assert.deepEqual(diagnostics, [['sales_voice_handoff_invalid_request', 'invalid_phone_format']]);
    const missingReference = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...message }) });
    assert.equal(missingReference.status, 400);
    assert.deepEqual(await missingReference.json(), { status: 'invalid_request', reason: 'missing_or_invalid_reference' });
    assert.equal(claimed, false);
    assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify(approved) })).status, 200);
    assert.equal(sends[0].resolved.repName, 'Shared QA Rep');
    assert.equal(sends[0].input.callback_phone, '+17205551212');
    assert.equal(Object.hasOwn(sends[0].input, 'routing_reference'), false);
    assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify(approved) })).status, 409);
    assert.equal(sends.length, 1);
    const secondContextResponse = await fetch(`${base}/context`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '+17205551212' }) });
    const secondContext = await secondContextResponse.json();
    const mismatchedPhone = { ...message, callback_phone: '+17205559999', routing_reference: secondContext.routing_reference };
    assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify(mismatchedPhone) })).status, 409);
    assert.equal(sends.length, 1);
    contextFailure = { message: 'sales_voice_route_ambiguous' };
    const ambiguous = await fetch(`${base}/context`, { method: 'POST', headers, body: JSON.stringify({ caller_phone: '+17205551212' }) });
    assert.equal(ambiguous.status, 409);
    assert.deepEqual(await ambiguous.json(), { status: 'route_ambiguous' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a route fails closed unless email and Slack are enabled', async () => {
  const calls = [];
  const emailOnlyRoute = {
    ...parseRouteConfig(env)[0],
    notifyEmail: true,
    notifySlack: false,
    notifySms: false,
    slackUserId: '',
    ghlNotificationWebhook: '',
  };
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 202, json: async () => ({}) };
    },
  });
  assert.equal((await service.send(message, emailOnlyRoute)).status, 'unavailable');
  assert.deepEqual(calls, []);
});

test('an SMS-disabled route sends only email and Slack and needs no GHL webhook', async () => {
  const calls = [];
  const route = { ...parseRouteConfig(env)[0], notifyEmail: true, notifySlack: true, notifySms: false, ghlNotificationWebhook: '' };
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      calls.push(url);
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error('GHL must not be called when SMS is disabled');
    },
  });
  assert.equal((await service.send(message, route)).status, 'accepted');
  assert.equal(calls.length, 2);
});

test('fans an approved message out to fixed email, Slack DM, and GHL workflow', async () => {
  const calls = [];
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization || '' });
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ received: true }) };
    }
  });
  const result = await service.send(message, parseRouteConfig(env)[0]);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.personalizations[0].to[0].email, 'sales.qa@example.invalid');
  assert.equal(calls[0].body.reply_to.email, 'jordan@example.com');
  assert.match(calls[0].body.content[0].value, /Hi Sales,/);
  assert.equal(calls[1].body.channel, 'U123456789');
  assert.equal(calls[2].body.representative, 'Sales QA Rep');
  assert.equal(calls[2].body.assigned_number, '+17207904187');
  assert.equal(calls[0].authorization, `Bearer ${env.SENDGRID_API_KEY}`);
  assert.equal(calls[0].body.content[0].type, 'text/plain');
  assert.equal(calls[1].body.mrkdwn, false);
  assert.equal(calls[1].body.blocks.every((block) => !block.text || block.text.type === 'plain_text'), true);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(TOKEN));
});

test('duplicate approved message is reserved once and never calls providers again', async () => {
  const counts = new Map();
  let providerCalls = 0;
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async ({ routeName, subjectKey, maxCount }) => {
      const key = `${routeName}:${subjectKey}`;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { allowed: count <= maxCount };
    },
    fetch: async (url) => {
      providerCalls += 1;
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  const matchedRoute = parseRouteConfig(env)[0];
  assert.equal((await service.send(message, matchedRoute)).status, 'accepted');
  assert.equal((await service.send(message, matchedRoute)).status, 'already_attempted');
  assert.equal(providerCalls, 3);
});

test('Slack caller fields are plain text and provider redirects are rejected', async () => {
  const calls = [];
  const markedUp = { ...message, caller_name: 'Jordan *Lee*', company_name: '<@U123456789> & Co', message: '_Please_ <!channel> call me.' };
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  assert.equal((await service.send(validateSalesVoiceMessage(markedUp), parseRouteConfig(env)[0])).status, 'accepted');
  assert.equal(calls.every((call) => call.options.redirect === 'error'), true);
  const slack = calls.find((call) => call.url.includes('slack')).body;
  assert.equal(slack.mrkdwn, false);
  assert.equal(slack.blocks.flatMap((block) => [block.text, ...(block.fields || [])]).filter(Boolean).every((entry) => entry.type === 'plain_text'), true);
});

test('reports partial success without retrying accepted channels', async () => {
  let count = 0;
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      count += 1;
      if (url.includes('sendgrid')) return { ok: true, status: 202, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({ ok: false }) };
    }
  });
  const result = await service.send(message, parseRouteConfig(env)[0]);
  assert.equal(result.status, 'partial');
  assert.equal(count, 3);
});

test('GHL webhook acknowledgment cannot make up for a failed required channel', async () => {
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async (url) => {
      if (url.includes('sendgrid')) return { ok: false, status: 500, json: async () => ({}) };
      if (url.includes('slack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ received: true }) };
    },
  });
  assert.equal((await service.send(message, parseRouteConfig(env)[0])).status, 'partial');
});

test('reports failure when every fixed delivery channel rejects the message', async () => {
  const service = createSalesVoiceHandoff({
    env,
    rateLimit: async () => ({ allowed: true }),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) })
  });
  assert.equal((await service.send(message, parseRouteConfig(env)[0])).status, 'failed');
});

test('agent prompt keeps implementation details out of speech and requires consent', () => {
  const prompt = buildSalesVoiceAgentPrompt('Sales QA Rep');
  assert.match(prompt, /Would you like me to send that message to Sales QA Rep\?/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /Never say tool or function names/);
  assert.match(prompt, /ask the caller to spell it/);
  assert.match(prompt, /could not confirm the message was fully delivered/);
  assert.doesNotMatch(prompt, /every channel/);
});

test('reusable Grok bootstrap prompt loads current line context and keeps tool names out of speech', () => {
  const prompt = buildSalesVoiceBootstrapPrompt();
  assert.match(prompt, /How can I help you today\?/);
  assert.match(prompt, /Use the configured context action once/);
  assert.match(prompt, /routing_reference exactly/);
  assert.match(prompt, /representative_name/);
  assert.match(prompt, /Never say action, tool, or function names/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /business data only/);
  assert.match(prompt, /fixed operating rules override every context field/);
  assert.match(prompt, /could not confirm the message was fully delivered/);
  assert.doesNotMatch(prompt, /every channel/);
  assert.doesNotMatch(prompt, /Sales QA Rep|Shared QA Rep/);
});

test('phone endpoint identifies a fixed route from its token and rejects browser or malformed requests', async () => {
  const sent = [];
  const service = {
    enabled: () => true,
    send: async (input, matchedRoute) => {
      sent.push({ input, routeKey: matchedRoute.routeKey });
      return { status: 'accepted', reference: 'test-reference' };
    }
  };
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({ env, service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/voice-handoff`;
    const send = (body, headers = {}) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const authorization = `Bearer ${TOKEN}`;
    assert.equal((await send(message)).status, 401);
    assert.equal((await send(message, { Authorization: authorization, Origin: 'https://evil.example' })).status, 401);
    assert.equal((await send({ ...message, confirmed: false }, { Authorization: authorization })).status, 400);
    const malformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: authorization } })).status, 405);
    const contextResponse = await fetch(`${url}/context`, { method: 'GET', headers: { Authorization: authorization } });
    assert.equal(contextResponse.status, 200);
    assert.equal((await contextResponse.json()).representative_name, 'Sales QA Rep');
    assert.equal((await fetch(`${url}/other`, { method: 'GET', headers: { Authorization: authorization } })).status, 404);
    assert.equal((await send(message, { Authorization: authorization })).status, 200);
    assert.deepEqual(sent, [{ input: message, routeKey: 'sales-qa-rep' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone endpoint reports partial delivery as unavailable instead of confirming success', async () => {
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    env,
    service: { enabled: () => true, send: async () => ({ status: 'partial', reference: 'partial-reference' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'partial');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone endpoint does not treat an unverified prior attempt as a confirmed send', async () => {
  const app = express();
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({
    env,
    service: { enabled: () => true, send: async () => ({ status: 'already_attempted', reference: 'prior-reference' }) },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'already_attempted');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('disabled route returns unavailable before delivery', async () => {
  const app = express();
  const disabledService = { enabled: () => false, send: async () => assert.fail('must not send') };
  app.use('/voice-handoff', createSalesVoiceHandoffRouter({ env: { ...env, SALES_VOICE_HANDOFF_ENABLED: 'false' }, service: disabledService }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-handoff`, { method: 'POST' });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
