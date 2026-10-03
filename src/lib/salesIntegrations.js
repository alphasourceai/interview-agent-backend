'use strict';

const crypto = require('node:crypto');
const { supabaseAdmin } = require('./supabaseClient');
const { ghlSalesConfiguration, markGhlOpportunityWon, recordGhlSyncEvent } = require('./ghlSalesIntegration');

const SALES_WON_EVENT_TYPE = 'sales_won';
const SALES_WON_REP_DM_EVENT_TYPE = 'sales_won_rep_dm';
const SLACK_INTEGRATION = 'slack';
const GHL_INTEGRATION = 'ghl';
const GHL_SALES_WON_EVENT_TYPE = 'sales_won';
const DEFAULT_BATCH_SIZE = 10;
const MAX_RECONCILE_ROWS = 100;
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 10800, 21600, 21600, 21600];
const PERMANENT_SLACK_ERRORS = new Set([
  'account_inactive',
  'channel_not_found',
  'cannot_dm_bot',
  'invalid_auth',
  'is_archived',
  'not_authed',
  'not_in_channel',
  'token_revoked',
  'user_not_found'
]);

function cleanText(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeSlackText(value, max = 500) {
  return cleanText(value, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayPlan(planKey) {
  const key = cleanText(planKey, 20).toLowerCase();
  if (key === 'basic') return 'Essential';
  if (key === 'pro') return 'Pro';
  return 'alphaScreen';
}

function displayCadence(cadence) {
  const value = cleanText(cadence, 20).toLowerCase();
  if (value === 'annual') return 'Annual';
  if (value === 'monthly') return 'Monthly';
  return 'Membership';
}

function toSlackDate(isoValue) {
  const parsed = new Date(isoValue);
  if (!Number.isFinite(parsed.getTime())) return cleanText(isoValue, 80) || 'Payment received';
  const epoch = Math.floor(parsed.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${parsed.toISOString()}>`;
}

function buildSalesWonPayload(intent, rep = null) {
  const companyName = cleanText(intent?.company_dba || intent?.company_legal_name, 160) || 'New alphaScreen client';
  const repName = cleanText(rep?.display_name, 120) || 'alphaSource sales team';
  return {
    schema_version: 1,
    company_name: companyName,
    membership: displayPlan(intent?.selected_plan_key),
    billing_cadence: displayCadence(intent?.selected_billing_cadence),
    sales_representative: repName,
    activated_at: cleanText(intent?.activated_at, 80),
    slack_user_id: cleanText(rep?.slack_user_id, 24)
  };
}

function buildSlackSalesWonMessage(payload) {
  const membership = `${escapeSlackText(payload?.membership, 40)} · ${escapeSlackText(payload?.billing_cadence, 40)}`;
  const firstName = cleanText(payload?.sales_representative, 120).split(/\s+/)[0] || 'sales team';
  const text = `Congratulations, ${escapeSlackText(firstName, 40)}!! 🎉 ${escapeSlackText(payload?.company_name, 160)} completed checkout and is now active!`;
  const fields = [
    { type: 'mrkdwn', text: `*Company*\n${escapeSlackText(payload?.company_name, 160)}` },
    { type: 'mrkdwn', text: `*Membership*\n${membership}` },
    { type: 'mrkdwn', text: `*Sales representative*\n${escapeSlackText(payload?.sales_representative, 120)}` }
  ];
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Congratulations, ${firstName.slice(0, 40)}!! 🎉`, emoji: true } },
      { type: 'section', fields },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Activated ${toSlackDate(payload?.activated_at)}`
        }]
      }
    ]
  };
}

function buildSlackSalesRepMessage(payload) {
  const company = escapeSlackText(payload?.company_name, 160);
  return {
    text: `${company} completed checkout and is now active. Great work!`,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🎉 *${company} completed checkout and is now active.*\nGreat work!`
      }
    }]
  };
}

function slackConfiguration(env = process.env) {
  return {
    botToken: cleanText(env.SLACK_SALES_WON_BOT_TOKEN, 500),
    channelId: cleanText(env.SLACK_SALES_WON_CHANNEL_ID, 120),
    configured: Boolean(cleanText(env.SLACK_SALES_WON_BOT_TOKEN, 500) && cleanText(env.SLACK_SALES_WON_CHANNEL_ID, 120))
  };
}

function teamSalesWonChannelEnabled(env = process.env) {
  // The shared channel has a broader audience than the QA test rep. Opt in
  // only after its recipients are reviewed for the target environment.
  return cleanText(env.SALES_WON_TEAM_CHANNEL_ENABLED, 10).toLowerCase() === 'true';
}

function validSlackUserId(value) {
  return /^[UW][A-Z0-9]{8,20}$/.test(cleanText(value, 24));
}

async function loadSalesWonIntent(db, purchaseIntentId) {
  const { data, error } = await db
    .from('public_purchase_intents')
    .select('id,status,channel,activated_at,client_id,agreement_id,ghl_contact_id,ghl_opportunity_id,stripe_checkout_session_id,company_legal_name,company_dba,selected_plan_key,selected_billing_cadence,created_by_user_id,created_by_email,platform_fee_cents,promotion_discount_cents,initial_payment_cents,sales_won_enqueued_at,sales_rep_slack_enqueued_at')
    .eq('id', purchaseIntentId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Sales-won intent lookup failed');
  return data || null;
}

async function loadGhlSalesContext(db, intent) {
  if (!intent?.agreement_id || !intent?.ghl_contact_id || !intent?.ghl_opportunity_id) return null;
  const [{ data: agreement, error: agreementError }, { data: binding, error: bindingError }] = await Promise.all([
    db.from('membership_agreements')
      .select('id,status,checkout_status,checkout_session_id,checkout_paid_at,is_current')
      .eq('id', intent.agreement_id)
      .maybeSingle(),
    db.from('ghl_sales_deal_bindings')
      .select('id,location_id,contact_id,opportunity_id,pipeline_id,ready_stage_id,provider_owner_user_id,sales_team_member_id,sales_rep_user_id,purchase_intent_id,status,manual_review_required')
      .eq('purchase_intent_id', intent.id)
      .maybeSingle()
  ]);
  if (agreementError) throw new Error(agreementError.message || 'Sales agreement lookup failed');
  if (bindingError) throw new Error(bindingError.message || 'GHL sales binding lookup failed');
  return { agreement: agreement || null, binding: binding || null };
}

function agreementIsSignedAndPaid(agreement) {
  return Boolean(
    agreement?.id &&
    cleanText(agreement.status, 40).toLowerCase() === 'signed' &&
    cleanText(agreement.checkout_status, 40).toLowerCase() === 'paid' &&
    cleanText(agreement.checkout_paid_at, 80)
  );
}

async function loadSalesRep(db, userId) {
  if (!userId) return null;
  const { data, error } = await db
    .from('sales_reps')
    .select('user_id,display_name,email,slack_user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Sales representative lookup failed');
  return data || null;
}

async function clientIsActivated(db, clientId) {
  if (!clientId) return false;
  const { data, error } = await db
    .from('clients')
    .select('id,billing_status,subscription_status')
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Activated client lookup failed');
  const billingStatus = cleanText(data?.billing_status, 40).toLowerCase();
  const subscriptionStatus = cleanText(data?.subscription_status, 40).toLowerCase();
  return Boolean(data?.id && billingStatus === 'active' && (!subscriptionStatus || ['active', 'trialing'].includes(subscriptionStatus)));
}

async function recordTerminalGhlReconciliationState(db, intent, code) {
  if (!intent?.id || !intent?.ghl_opportunity_id) return;
  await recordGhlSyncEvent(db, {
    purchaseIntentId: intent.id,
    direction: 'outbound',
    eventType: 'reconciliation_ineligible',
    idempotencyKey: `reconcile:${intent.id}:${code}`,
    status: 'manual_review',
    safeMetadata: { reason: code },
    errorCode: code,
    errorDetail: 'The completed GHL-linked sale did not satisfy the server-side Won reconciliation predicates.',
  });
}

async function enqueueSalesWonDelivery(purchaseIntentId, options = {}) {
  const db = options.db || supabaseAdmin;
  const env = options.env || process.env;
  const intent = options.intent || await loadSalesWonIntent(db, purchaseIntentId);
  if (!intent?.id) return { enqueued: false, status: 'intent_not_found' };
  if (
    cleanText(intent.channel, 40).toLowerCase() !== 'sales_assisted' ||
    cleanText(intent.status, 40).toLowerCase() !== 'completed' ||
    !cleanText(intent.activated_at, 80)
  ) {
    return { enqueued: false, status: 'not_eligible' };
  }
  if (!(await clientIsActivated(db, intent.client_id))) {
    await recordTerminalGhlReconciliationState(db, intent, 'ghl_client_not_active');
    return { enqueued: false, status: 'activation_pending' };
  }

  const rep = await loadSalesRep(db, intent.created_by_user_id);
  const payload = buildSalesWonPayload(intent, rep);
  const rows = [];
  if (!intent.sales_won_enqueued_at && teamSalesWonChannelEnabled(env)) {
    rows.push({
      integration: SLACK_INTEGRATION,
      event_type: SALES_WON_EVENT_TYPE,
      event_key: `sales_won:${intent.id}`,
      purchase_intent_id: intent.id,
      payload: { ...payload, slack_user_id: undefined },
      status: 'pending',
      next_attempt_at: new Date().toISOString()
    });
  }
  if (!intent.sales_rep_slack_enqueued_at && validSlackUserId(payload.slack_user_id)) {
    rows.push({
      integration: SLACK_INTEGRATION,
      event_type: SALES_WON_REP_DM_EVENT_TYPE,
      event_key: `sales_won_rep_dm:${intent.id}`,
      purchase_intent_id: intent.id,
      payload,
      status: 'pending',
      next_attempt_at: new Date().toISOString()
    });
  }
  let ghlContext = null;
  let ghlStatus = null;
  if (intent.ghl_contact_id && intent.ghl_opportunity_id) {
    ghlContext = await loadGhlSalesContext(db, intent);
    if (!ghlContext?.binding || !agreementIsSignedAndPaid(ghlContext.agreement)) {
      ghlStatus = !ghlContext?.binding ? 'ghl_binding_missing' : 'agreement_not_signed_and_paid';
      await recordTerminalGhlReconciliationState(db, intent, ghlStatus);
    } else {
      rows.push({
        integration: GHL_INTEGRATION,
        event_type: GHL_SALES_WON_EVENT_TYPE,
        event_key: `ghl_sales_won:${intent.id}`,
        purchase_intent_id: intent.id,
        payload: {
          schema_version: 1,
          binding_id: ghlContext.binding.id,
          opportunity_id: ghlContext.binding.opportunity_id,
          contact_id: ghlContext.binding.contact_id
        },
        status: 'pending',
        next_attempt_at: new Date().toISOString()
      });
    }
  }

  const result = { enqueued: false, status: ghlStatus || 'already_enqueued', team: false, rep_dm: false, ghl: false };
  for (const row of rows) {
    const { data, error } = await db.from('sales_integration_deliveries').insert(row).select('id,status').maybeSingle();
    const duplicate = error && (cleanText(error.code, 40) === '23505' || /duplicate/i.test(cleanText(error.message, 500)));
    if (error && !duplicate) throw new Error(error.message || 'Sales-won delivery enqueue failed');
    if (!error) {
      result.enqueued = true;
      result.status = data?.status || 'pending';
      if (row.integration === SLACK_INTEGRATION && row.event_type === SALES_WON_EVENT_TYPE) result.team = true;
      if (row.event_type === SALES_WON_REP_DM_EVENT_TYPE) result.rep_dm = true;
      if (row.integration === GHL_INTEGRATION) result.ghl = true;
    }
  }

  const markerNow = new Date().toISOString();
  const markerPayload = { updated_at: markerNow };
  if (rows.some((row) => row.event_type === SALES_WON_EVENT_TYPE)) markerPayload.sales_won_enqueued_at = markerNow;
  if (rows.some((row) => row.event_type === SALES_WON_REP_DM_EVENT_TYPE)) markerPayload.sales_rep_slack_enqueued_at = markerNow;
  const { error: markerError } = await db.from('public_purchase_intents').update(markerPayload).eq('id', intent.id);
  if (markerError) options.logger?.warn?.('[sales-integrations] sales_won_marker_failed', {
    purchase_intent_id: intent.id,
    error: cleanText(markerError.message, 300)
  });
  return result;
}

async function reconcileSalesWonDeliveries(options = {}) {
  const db = options.db || supabaseAdmin;
  const env = options.env || process.env;
  const limit = Math.max(1, Math.min(Number(options.limit || MAX_RECONCILE_ROWS), MAX_RECONCILE_ROWS));
  const { data: teamRows, error: teamError } = teamSalesWonChannelEnabled(env)
    ? await db.from('public_purchase_intents')
      .select('id')
      .eq('channel', 'sales_assisted')
      .eq('status', 'completed')
      .not('activated_at', 'is', null)
      .is('sales_won_enqueued_at', null)
      .order('activated_at', { ascending: true })
      .limit(limit)
    : { data: [], error: null };
  if (teamError) throw new Error(teamError.message || 'Sales-won reconciliation lookup failed');

  const { data: repRows, error: repError } = await db
    .from('sales_reps')
    .select('user_id,slack_user_id')
    .not('slack_user_id', 'is', null)
    .limit(MAX_RECONCILE_ROWS);
  if (repError) throw new Error(repError.message || 'Sales representative reconciliation lookup failed');
  const mappedUserIds = (Array.isArray(repRows) ? repRows : [])
    .filter((row) => row?.user_id && validSlackUserId(row.slack_user_id))
    .map((row) => row.user_id);

  let dmRows = [];
  if (mappedUserIds.length) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id')
      .eq('channel', 'sales_assisted')
      .eq('status', 'completed')
      .not('activated_at', 'is', null)
      .is('sales_rep_slack_enqueued_at', null)
      .in('created_by_user_id', mappedUserIds)
      .order('activated_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message || 'Sales representative DM reconciliation lookup failed');
    dmRows = Array.isArray(data) ? data : [];
  }

  const { data: ghlRows, error: ghlError } = await db.rpc('list_missing_ghl_sales_won_intents', {
    p_limit: limit,
  });
  if (ghlError) throw new Error(ghlError.message || 'GHL sales reconciliation lookup failed');

  const candidateIds = [...new Set([
    ...(Array.isArray(teamRows) ? teamRows : []).map((row) => row.id),
    ...dmRows.map((row) => row.id),
    ...(Array.isArray(ghlRows) ? ghlRows : []).map((row) => row.id)
  ].filter(Boolean))];

  const summary = { scanned: 0, enqueued: 0, existing: 0, pending_activation: 0, pending_agreement_or_binding: 0, failed: 0 };
  for (const purchaseIntentId of candidateIds) {
    summary.scanned += 1;
    try {
      const result = await enqueueSalesWonDelivery(purchaseIntentId, { db, env, logger: options.logger });
      if (result.enqueued) summary.enqueued += 1;
      else if (result.status === 'already_enqueued') summary.existing += 1;
      else if (result.status === 'activation_pending') summary.pending_activation += 1;
      else if (['ghl_binding_missing', 'agreement_not_signed_and_paid'].includes(result.status)) summary.pending_agreement_or_binding += 1;
    } catch (error) {
      summary.failed += 1;
      options.logger?.warn?.('[sales-integrations] reconciliation_enqueue_failed', {
        purchase_intent_id: purchaseIntentId,
        error: cleanText(error?.message, 300)
      });
    }
  }
  return summary;
}

async function postSlackMessage(delivery, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const config = slackConfiguration(env);
  if (!config.configured) {
    const error = new Error('Slack sales-won delivery is not configured.');
    error.code = 'slack_not_configured';
    error.retryable = true;
    throw error;
  }
  if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation unavailable.');
  const isRepDm = delivery.event_type === SALES_WON_REP_DM_EVENT_TYPE;
  if (!isRepDm && !teamSalesWonChannelEnabled(env)) {
    const error = new Error('Shared sales-won channel is not enabled for this environment.');
    error.code = 'slack_team_channel_disabled';
    error.retryable = false;
    throw error;
  }
  const slackUserId = cleanText(delivery.payload?.slack_user_id, 24);
  if (isRepDm && !validSlackUserId(slackUserId)) {
    const error = new Error('Slack member ID is invalid.');
    error.code = 'invalid_slack_user_id';
    error.retryable = false;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 10000));
  let response;
  try {
    response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel: isRepDm
          ? slackUserId
          : config.channelId,
        client_msg_id: delivery.id,
        ...(delivery.event_type === SALES_WON_REP_DM_EVENT_TYPE
          ? buildSlackSalesRepMessage(delivery.payload)
          : buildSlackSalesWonMessage(delivery.payload))
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = {};
  }
  if (!response.ok || body.ok !== true) {
    const error = new Error(cleanText(body.error, 160) || `slack_http_${response.status}`);
    error.code = cleanText(body.error, 160) || `slack_http_${response.status}`;
    error.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
    error.retryable = !PERMANENT_SLACK_ERRORS.has(error.code);
    throw error;
  }
  return {
    external_message_id: cleanText(body.ts, 120) || null,
    external_channel_id: cleanText(body.channel, 120) || (isRepDm
      ? slackUserId
      : config.channelId)
  };
}

function retryDelaySeconds(attemptCount, error) {
  const retryAfter = Number(error?.retryAfterSeconds || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 21600);
  const count = Number.isSafeInteger(Number(attemptCount)) ? Number(attemptCount) : 0;
  const index = Math.max(0, Math.min(count - 1, RETRY_DELAYS_SECONDS.length - 1));
  return RETRY_DELAYS_SECONDS[index];
}

async function updateClaimedDelivery(db, delivery, payload) {
  const { error } = await db
    .from('sales_integration_deliveries')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', delivery.id)
    .eq('lock_token', delivery.lock_token);
  if (error) throw new Error(error.message || 'Sales integration delivery update failed');
}

async function processGhlSalesWonDelivery(db, delivery, options = {}) {
  const intent = await loadSalesWonIntent(db, delivery.purchase_intent_id);
  if (
    !intent?.id ||
    cleanText(intent.channel, 40).toLowerCase() !== 'sales_assisted' ||
    cleanText(intent.status, 40).toLowerCase() !== 'completed' ||
    !cleanText(intent.activated_at, 80)
  ) {
    const error = new Error('The alphaScreen sale is no longer eligible for a GHL Won update.');
    error.code = 'ghl_sale_not_eligible';
    error.retryable = false;
    error.manualReview = true;
    throw error;
  }
  if (!(await clientIsActivated(db, intent.client_id))) {
    const error = new Error('The alphaScreen client is not active.');
    error.code = 'ghl_client_not_active';
    error.retryable = false;
    error.manualReview = true;
    throw error;
  }
  const context = await loadGhlSalesContext(db, intent);
  if (!agreementIsSignedAndPaid(context?.agreement)) {
    const error = new Error('The alphaScreen agreement is not both signed and paid.');
    error.code = 'ghl_agreement_not_signed_and_paid';
    error.retryable = false;
    error.manualReview = true;
    throw error;
  }
  if (
    !context?.binding?.id ||
    context.binding.id !== delivery.payload?.binding_id ||
    context.binding.purchase_intent_id !== intent.id ||
    context.binding.manual_review_required
  ) {
    const error = new Error('The GHL mapping requires administrator review.');
    error.code = 'ghl_binding_invalid';
    error.retryable = false;
    error.manualReview = true;
    throw error;
  }

  const startedAt = new Date().toISOString();
  const { error: pendingError } = await db.from('ghl_sales_deal_bindings').update({
    status: context.binding.status === 'won' ? 'won' : 'won_pending',
    last_error_code: null,
    last_error_detail: null,
    updated_at: startedAt
  }).eq('id', context.binding.id).eq('purchase_intent_id', intent.id);
  if (pendingError) throw new Error(pendingError.message || 'GHL binding status update failed');
  await recordGhlSyncEvent(db, {
    bindingId: context.binding.id,
    purchaseIntentId: intent.id,
    direction: 'outbound',
    eventType: 'opportunity_won_attempt',
    idempotencyKey: `outbound:${delivery.id}:attempt:${delivery.attempt_count}`,
    status: 'received',
    safeMetadata: { delivery_id: delivery.id, attempt_count: Number(delivery.attempt_count || 0) }
  });
  const result = await markGhlOpportunityWon(delivery, { intent, ...context }, options);
  const completedAt = new Date().toISOString();
  const { error: bindingError } = await db.from('ghl_sales_deal_bindings').update({
    status: 'won',
    won_at: completedAt,
    last_sync_at: completedAt,
    last_error_code: null,
    last_error_detail: null,
    manual_review_required: false,
    updated_at: completedAt
  }).eq('id', context.binding.id).eq('purchase_intent_id', intent.id);
  if (bindingError) throw new Error(bindingError.message || 'GHL binding completion update failed');
  await recordGhlSyncEvent(db, {
    bindingId: context.binding.id,
    purchaseIntentId: intent.id,
    direction: 'outbound',
    eventType: 'opportunity_won',
    idempotencyKey: `outbound:${delivery.id}:completed`,
    status: 'completed',
    safeMetadata: { delivery_id: delivery.id, note_created: result.noteCreated === true }
  });
  return {
    external_message_id: result.noteId || null,
    external_channel_id: result.opportunityId
  };
}

async function markGhlDeliveryFailure(db, delivery, error) {
  const bindingId = cleanText(delivery?.payload?.binding_id, 80);
  if (!bindingId) return;
  const manualReview = error?.manualReview === true || error?.retryable === false;
  const now = new Date().toISOString();
  const { error: updateError } = await db.from('ghl_sales_deal_bindings').update({
    status: manualReview ? 'exception' : 'won_pending',
    last_sync_at: now,
    last_error_code: cleanText(error?.code || 'ghl_delivery_failed', 80),
    last_error_detail: cleanText(error?.message || 'GHL delivery failed', 500),
    manual_review_required: manualReview,
    updated_at: now
  }).eq('id', bindingId).eq('purchase_intent_id', delivery.purchase_intent_id);
  if (updateError) throw new Error(updateError.message || 'GHL binding failure update failed');
  await recordGhlSyncEvent(db, {
    bindingId,
    purchaseIntentId: delivery.purchase_intent_id,
    direction: 'outbound',
    eventType: 'opportunity_won',
    idempotencyKey: `outbound:${delivery.id}:failure:${delivery.attempt_count}`,
    status: manualReview ? 'manual_review' : 'retrying',
    safeMetadata: { delivery_id: delivery.id, attempt_count: Number(delivery.attempt_count || 0) },
    errorCode: cleanText(error?.code || 'ghl_delivery_failed', 80),
    errorDetail: cleanText(error?.message || 'GHL delivery failed', 500)
  });
}

async function processSalesIntegrationDeliveries(options = {}) {
  const db = options.db || supabaseAdmin;
  const logger = options.logger || console;
  const env = options.env || process.env;
  const reconciliation = await reconcileSalesWonDeliveries({ db, env, logger, limit: options.reconcileLimit });
  const slackConfig = slackConfiguration(env);
  const ghlConfig = ghlSalesConfiguration(env);
  const ghlConfigured = ghlConfig.configured && ghlConfig.syncEnabled;

  const batchSize = Math.max(1, Math.min(Number(options.limit || DEFAULT_BATCH_SIZE), 50));
  const lockToken = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const claimed = [];
  for (const integration of [
    ...(slackConfig.configured ? [SLACK_INTEGRATION] : []),
    ...(ghlConfigured ? [GHL_INTEGRATION] : []),
  ]) {
    const { data, error } = await db.rpc('claim_sales_integration_deliveries', {
      p_limit: batchSize,
      p_lock_token: lockToken,
      p_now: nowIso,
      p_integration: integration
    });
    if (error) throw new Error(error.message || `${integration} sales integration deliveries could not be claimed`);
    claimed.push(...(Array.isArray(data) ? data : []));
  }

  const summary = {
    ok: true,
    configured: {
      slack: slackConfig.configured,
      ghl: ghlConfigured
    },
    reconciliation,
    claimed: claimed.length,
    delivered: 0,
    retrying: 0,
    failed: 0
  };
  for (const delivery of claimed) {
    try {
      let result;
      if (delivery.integration === SLACK_INTEGRATION) {
        result = await postSlackMessage(delivery, { env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
      } else if (delivery.integration === GHL_INTEGRATION && delivery.event_type === GHL_SALES_WON_EVENT_TYPE) {
        result = await processGhlSalesWonDelivery(db, delivery, { env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
      } else {
        const unsupported = new Error('Unsupported sales integration delivery.');
        unsupported.code = 'sales_integration_unsupported';
        unsupported.retryable = false;
        throw unsupported;
      }
      await updateClaimedDelivery(db, delivery, {
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
        locked_at: null,
        lock_token: null,
        last_error: null,
        ...result
      });
      summary.delivered += 1;
    } catch (deliveryError) {
      const exhausted = Number(delivery.attempt_count || 0) >= Number(delivery.max_attempts || 0);
      const retryable = deliveryError?.retryable !== false && !exhausted;
      const delaySeconds = retryDelaySeconds(delivery.attempt_count, deliveryError);
      if (delivery.integration === GHL_INTEGRATION) {
        try {
          await markGhlDeliveryFailure(db, delivery, {
            ...deliveryError,
            code: deliveryError?.code,
            message: deliveryError?.message,
            retryable,
            manualReview: deliveryError?.manualReview === true || !retryable
          });
        } catch (failureUpdateError) {
          logger.error?.('[sales-integrations] ghl_failure_audit_failed', {
            delivery_id: delivery.id,
            error: cleanText(failureUpdateError?.message, 160)
          });
        }
      }
      await updateClaimedDelivery(db, delivery, {
        status: retryable ? 'retry' : 'failed',
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        locked_at: null,
        lock_token: null,
        last_error: cleanText(deliveryError?.code || deliveryError?.message || 'delivery_failed', 500),
        manual_review_required: delivery.integration === GHL_INTEGRATION && !retryable
      });
      if (retryable) summary.retrying += 1;
      else summary.failed += 1;
      logger.warn?.('[sales-integrations] delivery_failed', {
        delivery_id: delivery.id,
        integration: delivery.integration,
        attempt_count: delivery.attempt_count,
        retryable,
        error: cleanText(deliveryError?.code || deliveryError?.message, 160)
      });
    }
  }
  return summary;
}

module.exports = {
  GHL_INTEGRATION,
  GHL_SALES_WON_EVENT_TYPE,
  SALES_WON_EVENT_TYPE,
  SALES_WON_REP_DM_EVENT_TYPE,
  buildSalesWonPayload,
  buildSlackSalesWonMessage,
  buildSlackSalesRepMessage,
  enqueueSalesWonDelivery,
  agreementIsSignedAndPaid,
  loadGhlSalesContext,
  processGhlSalesWonDelivery,
  reconcileSalesWonDeliveries,
  postSlackMessage,
  processSalesIntegrationDeliveries,
  slackConfiguration,
  retryDelaySeconds
};
