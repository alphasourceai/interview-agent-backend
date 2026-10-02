'use strict';

const crypto = require('node:crypto');
const { supabaseAdmin } = require('./supabaseClient');
const { isScopedGhlSalesUser } = require('./ghlSalesUserScope');

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = 'v3';
const ID_RE = /^[A-Za-z0-9_-]{3,160}$/;

function clean(value, max = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function lowerEmail(value) {
  return clean(value, 254).toLowerCase();
}

function integrationError(code, detail, options = {}) {
  const error = new Error(detail || code);
  error.code = code;
  error.status = Number(options.status) || 500;
  error.retryable = options.retryable !== false;
  error.manualReview = options.manualReview === true;
  return error;
}

function requireId(value, field) {
  const normalized = clean(value, 160);
  if (!ID_RE.test(normalized)) {
    throw integrationError(`ghl_${field}_invalid`, `The GHL ${field.replaceAll('_', ' ')} is invalid.`, {
      status: 400,
      retryable: false,
      manualReview: true,
    });
  }
  return normalized;
}

function ghlSalesConfiguration(env = process.env) {
  const configuration = {
    token: clean(env.GHL_PRIVATE_INTEGRATION_TOKEN, 1000),
    locationId: clean(env.GHL_LOCATION_ID || env.GHL_SALES_LOCATION_ID, 160),
    pipelineId: clean(env.GHL_SALES_PIPELINE_ID, 160),
    readyStageId: clean(env.GHL_SALES_READY_STAGE_ID, 160),
    syncEnabled: clean(env.GHL_SALES_SYNC_ENABLED, 10).toLowerCase() === 'true',
  };
  configuration.configured = Boolean(
    configuration.token && configuration.locationId && configuration.pipelineId && configuration.readyStageId
  );
  return configuration;
}

function providerError(status, body = {}) {
  const providerMessage = clean(
    typeof body?.message === 'string' ? body.message : body?.error,
    240
  );
  const suffix = Number(status) || 'failed';
  if (status === 401 || status === 403) {
    return integrationError('ghl_scope_or_auth_invalid', 'GHL rejected the configured integration credentials or scopes.', {
      status: 503,
      retryable: false,
      manualReview: true,
    });
  }
  if (status === 404) {
    return integrationError('ghl_record_not_found', 'The mapped GHL record no longer exists.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return integrationError(`ghl_http_${suffix}`, providerMessage || 'GHL did not complete the request.', {
    status: retryable ? 503 : 409,
    retryable,
    manualReview: !retryable,
  });
}

async function ghlRequest(path, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const config = options.config || ghlSalesConfiguration(env);
  if (!config.token) {
    throw integrationError('ghl_token_missing', 'The GHL private integration is not configured.', {
      status: 503,
      retryable: false,
      manualReview: true,
    });
  }
  if (typeof fetchImpl !== 'function') throw integrationError('ghl_fetch_unavailable', 'The GHL client is unavailable.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(options.timeoutMs || 10000), 30000)));
  let response;
  try {
    response = await fetchImpl(`${GHL_API_BASE}${path}`, {
      method: options.method || 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Version: GHL_API_VERSION,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw integrationError('ghl_timeout', 'GHL did not respond before the request deadline.');
    throw integrationError('ghl_network_unavailable', 'GHL could not be reached.');
  } finally {
    clearTimeout(timeout);
  }
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw providerError(response.status, body);
  return body;
}

function unwrapOpportunity(body) {
  return body?.opportunity || body?.data?.opportunity || body?.data || body || {};
}

function unwrapContact(body) {
  return body?.contact || body?.data?.contact || body?.data || body || {};
}

async function fetchGhlOpportunity(opportunityId, options = {}) {
  const id = requireId(opportunityId, 'opportunity_id');
  const body = await ghlRequest(`/opportunities/${encodeURIComponent(id)}`, options);
  const opportunity = unwrapOpportunity(body);
  if (clean(opportunity?.id, 160) !== id) {
    throw integrationError('ghl_opportunity_mismatch', 'GHL returned an unexpected opportunity.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  return opportunity;
}

async function fetchGhlContact(contactId, options = {}) {
  const id = requireId(contactId, 'contact_id');
  const body = await ghlRequest(`/contacts/${encodeURIComponent(id)}`, options);
  const contact = unwrapContact(body);
  if (clean(contact?.id, 160) !== id) {
    throw integrationError('ghl_contact_mismatch', 'GHL returned an unexpected contact.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  return contact;
}

async function assertGhlSalesOwnerScope(userId, options = {}) {
  const id = requireId(userId, 'owner_user_id');
  const body = await ghlRequest(`/users/${encodeURIComponent(id)}`, options);
  const user = body?.user || body;
  if (clean(user?.id, 160) !== id || user?.deleted === true || user?.active === false) {
    throw integrationError('ghl_owner_verification_failed', 'GHL could not verify an active opportunity owner.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
  if (!isScopedGhlSalesUser(user, options.config.locationId)) {
    throw integrationError('ghl_owner_access_scope_invalid', 'The GHL owner must be an Account User assigned only to the configured location.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
}

function assertOpportunityBoundary(opportunity, config, options = {}) {
  const locationId = clean(opportunity?.locationId || opportunity?.location_id, 160);
  const pipelineId = clean(opportunity?.pipelineId || opportunity?.pipeline_id, 160);
  const stageId = clean(opportunity?.pipelineStageId || opportunity?.pipeline_stage_id, 160);
  const status = clean(opportunity?.status, 40).toLowerCase();
  if (locationId !== config.locationId) {
    throw integrationError('ghl_location_mismatch', 'The GHL opportunity belongs to another location.', {
      status: 403,
      retryable: false,
      manualReview: true,
    });
  }
  if (pipelineId !== config.pipelineId) {
    throw integrationError('ghl_pipeline_mismatch', 'The GHL opportunity is outside the configured sales pipeline.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  if (options.requireReadyStage && stageId !== config.readyStageId) {
    throw integrationError('ghl_ready_stage_mismatch', 'The GHL opportunity is not in Agreement/Checkout.', {
      status: 409,
      retryable: false,
    });
  }
  if (options.rejectClosed && status !== 'open') {
    throw integrationError('ghl_opportunity_not_open', 'The GHL opportunity is already closed.', {
      status: 409,
      retryable: false,
    });
  }
  return { locationId, pipelineId, stageId, status };
}

async function resolveActiveSalesRep(db, providerUserId) {
  const userId = requireId(providerUserId, 'owner_user_id');
  const { data: members, error: memberError } = await db
    .from('sales_team_members')
    .select('id,sales_rep_user_id,display_name,ghl_user_id,status')
    .eq('ghl_user_id', userId)
    .eq('status', 'active')
    .limit(2);
  if (memberError) throw integrationError('sales_rep_mapping_lookup_failed', 'The salesperson mapping could not be checked.');
  if (!Array.isArray(members) || members.length !== 1 || !members[0]?.sales_rep_user_id) {
    throw integrationError(members?.length > 1 ? 'sales_rep_mapping_ambiguous' : 'sales_rep_mapping_missing', 'The GHL owner does not map to exactly one active salesperson.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  const { data: rep, error: repError } = await db
    .from('sales_reps')
    .select('user_id,email,display_name,active')
    .eq('user_id', members[0].sales_rep_user_id)
    .eq('active', true)
    .maybeSingle();
  if (repError) throw integrationError('sales_rep_lookup_failed', 'The salesperson account could not be checked.');
  if (!rep) {
    throw integrationError('sales_rep_inactive', 'The mapped salesperson is not active in the sales dashboard.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  return { member: members[0], rep };
}

function normalizedBindingFields(opportunity, contact, config, mapping) {
  const ownerId = requireId(opportunity?.assignedTo || opportunity?.assigned_to, 'owner_user_id');
  return {
    location_id: config.locationId,
    contact_id: requireId(opportunity?.contactId || opportunity?.contact_id || contact?.id, 'contact_id'),
    opportunity_id: requireId(opportunity?.id, 'opportunity_id'),
    pipeline_id: config.pipelineId,
    ready_stage_id: config.readyStageId,
    provider_owner_user_id: ownerId,
    sales_team_member_id: mapping?.member?.id || null,
    sales_rep_user_id: mapping?.rep?.user_id || null,
    status: mapping ? 'ready' : 'exception',
    company_name: clean(contact?.companyName || contact?.company_name || opportunity?.contact?.companyName, 160) || null,
    contact_first_name: clean(contact?.firstName || contact?.first_name, 80) || null,
    contact_last_name: clean(contact?.lastName || contact?.last_name, 80) || null,
    contact_email: lowerEmail(contact?.email) || null,
    contact_phone: clean(contact?.phone, 40) || null,
    contact_title: clean(contact?.title || contact?.jobTitle, 120) || null,
    opportunity_name: clean(opportunity?.name, 200) || null,
    opportunity_source: clean(opportunity?.source, 120) || null,
    provider_updated_at: clean(opportunity?.updatedAt || opportunity?.updated_at, 80) || null,
    last_error_code: mapping ? null : 'sales_rep_mapping_missing',
    last_error_detail: mapping ? null : 'The GHL owner does not map to exactly one active salesperson.',
    manual_review_required: !mapping,
    updated_at: new Date().toISOString(),
  };
}

async function upsertGhlBinding(db, fields) {
  const { data: existing, error: lookupError } = await db
    .from('ghl_sales_deal_bindings')
    .select('id,purchase_intent_id,status,sales_rep_user_id')
    .eq('location_id', fields.location_id)
    .eq('opportunity_id', fields.opportunity_id)
    .maybeSingle();
  if (lookupError) throw integrationError('ghl_binding_lookup_failed', 'The GHL sales import could not be checked.');
  if (existing?.purchase_intent_id) {
    const { data, error } = await db.from('ghl_sales_deal_bindings')
      .update({
        company_name: fields.company_name,
        contact_first_name: fields.contact_first_name,
        contact_last_name: fields.contact_last_name,
        contact_email: fields.contact_email,
        contact_phone: fields.contact_phone,
        contact_title: fields.contact_title,
        opportunity_name: fields.opportunity_name,
        opportunity_source: fields.opportunity_source,
        provider_updated_at: fields.provider_updated_at,
        updated_at: fields.updated_at,
      })
      .eq('id', existing.id)
      .eq('purchase_intent_id', existing.purchase_intent_id)
      .select('*')
      .single();
    if (error) throw integrationError('ghl_binding_update_failed', 'The linked GHL sales import could not be refreshed.');
    return { binding: data, created: false };
  }
  if (existing) {
    const { data, error } = await db.from('ghl_sales_deal_bindings')
      .update(fields)
      .eq('id', existing.id)
      .is('purchase_intent_id', null)
      .in('status', ['ready', 'exception'])
      .select('*')
      .maybeSingle();
    if (error) throw integrationError('ghl_binding_update_failed', 'The GHL sales import could not be refreshed.');
    if (data) return { binding: data, created: false };

    const { data: current, error: rereadError } = await db
      .from('ghl_sales_deal_bindings')
      .select('id,purchase_intent_id,status,sales_rep_user_id')
      .eq('id', existing.id)
      .maybeSingle();
    if (rereadError || !current) throw integrationError('ghl_binding_update_failed', 'The GHL sales import could not be refreshed.');
    if (current.purchase_intent_id) return upsertGhlBinding(db, fields);
    throw integrationError('ghl_binding_not_refreshable', 'The GHL sales import is no longer refreshable.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  const { data, error } = await db.from('ghl_sales_deal_bindings')
    .insert(fields)
    .select('*')
    .single();
  if (error) {
    if (clean(error.code, 40) === '23505') {
      return upsertGhlBinding(db, fields);
    }
    throw integrationError('ghl_binding_create_failed', 'The GHL sales import could not be recorded.');
  }
  return { binding: data, created: true };
}

async function recordGhlSyncEvent(db, event) {
  const payload = {
    binding_id: event.bindingId || null,
    purchase_intent_id: event.purchaseIntentId || null,
    direction: clean(event.direction, 20),
    event_type: clean(event.eventType, 80),
    idempotency_key: clean(event.idempotencyKey, 255),
    status: clean(event.status, 40),
    safe_metadata: event.safeMetadata && typeof event.safeMetadata === 'object' && !Array.isArray(event.safeMetadata)
      ? event.safeMetadata
      : {},
    error_code: clean(event.errorCode, 80) || null,
    error_detail: clean(event.errorDetail, 500) || null,
  };
  const { error } = await db.from('ghl_sales_sync_events').insert(payload);
  if (error && clean(error.code, 40) !== '23505') {
    throw integrationError('ghl_audit_event_failed', 'The GHL integration audit event could not be recorded.');
  }
}

async function importReadyGhlOpportunity(opportunityId, options = {}) {
  const db = options.db || supabaseAdmin;
  const env = options.env || process.env;
  const config = ghlSalesConfiguration(env);
  if (!config.configured) {
    throw integrationError('ghl_sales_import_not_configured', 'The GHL sales import is not configured.', {
      status: 503,
      retryable: false,
      manualReview: true,
    });
  }
  const requestOptions = { env, fetchImpl: options.fetchImpl, config };
  const opportunity = await fetchGhlOpportunity(opportunityId, requestOptions);
  assertOpportunityBoundary(opportunity, config, { requireReadyStage: true, rejectClosed: true });
  const contactId = requireId(opportunity?.contactId || opportunity?.contact_id || opportunity?.contact?.id, 'contact_id');
  const contact = await fetchGhlContact(contactId, requestOptions);
  const ownerId = requireId(opportunity?.assignedTo || opportunity?.assigned_to, 'owner_user_id');
  let mapping = null;
  let mappingError = null;
  try {
    await assertGhlSalesOwnerScope(ownerId, requestOptions);
    mapping = await resolveActiveSalesRep(db, ownerId);
  } catch (error) {
    mappingError = error;
  }
  const fields = normalizedBindingFields(opportunity, contact, config, mapping);
  if (mappingError) {
    fields.last_error_code = clean(mappingError.code, 80) || 'sales_rep_mapping_missing';
    fields.last_error_detail = clean(mappingError.message, 500);
  }
  const result = await upsertGhlBinding(db, fields);
  if (mappingError) {
    mappingError.bindingId = result.binding?.id || null;
    throw mappingError;
  }
  return { ...result, opportunity, contact };
}

async function verifyReadyGhlBinding(binding, options = {}) {
  const db = options.db || supabaseAdmin;
  const env = options.env || process.env;
  const config = ghlSalesConfiguration(env);
  if (!config.configured) {
    throw integrationError('ghl_sales_import_not_configured', 'The GHL sales import is not configured.', {
      status: 503, retryable: false, manualReview: true,
    });
  }
  if (!binding?.id || clean(binding.location_id, 160) !== config.locationId ||
      clean(binding.pipeline_id, 160) !== config.pipelineId ||
      clean(binding.ready_stage_id, 160) !== config.readyStageId ||
      binding.status !== 'ready' || binding.purchase_intent_id || binding.manual_review_required) {
    throw integrationError('ghl_binding_not_ready', 'The GHL sales draft is no longer ready.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
  const requestOptions = { env, fetchImpl: options.fetchImpl, config };
  const opportunity = await fetchGhlOpportunity(binding.opportunity_id, requestOptions);
  assertOpportunityBoundary(opportunity, config, { requireReadyStage: true, rejectClosed: true });
  if (clean(opportunity?.contactId || opportunity?.contact_id, 160) !== clean(binding.contact_id, 160)) {
    throw integrationError('ghl_contact_changed', 'The GHL opportunity contact changed after import.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
  const ownerId = requireId(opportunity?.assignedTo || opportunity?.assigned_to, 'owner_user_id');
  if (ownerId !== clean(binding.provider_owner_user_id, 160)) {
    throw integrationError('ghl_owner_changed', 'The GHL opportunity owner changed after import.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
  await assertGhlSalesOwnerScope(ownerId, requestOptions);
  const mapping = await resolveActiveSalesRep(db, ownerId);
  if (mapping.member.id !== binding.sales_team_member_id || mapping.rep.user_id !== binding.sales_rep_user_id) {
    throw integrationError('ghl_owner_mapping_changed', 'The assigned salesperson changed after import.', {
      status: 409, retryable: false, manualReview: true,
    });
  }
  return opportunity;
}

function buildGhlWinNote({ delivery, intent, binding, agreement }) {
  const discountCents = Math.max(0, Number(intent?.promotion_discount_cents || 0));
  const lines = [
    `alphaScreen activation synchronized [alphaScreen sync:${clean(delivery?.id, 80)}]`,
    `Platform client: ${clean(intent?.client_id, 80)}`,
    `Agreement: ${clean(intent?.agreement_id, 80)}`,
    `Payment: ${clean(intent?.stripe_checkout_session_id || agreement?.checkout_session_id, 120)}`,
    `Membership: ${clean(intent?.selected_plan_key, 20) === 'basic' ? 'Essential' : 'Pro'} (${clean(intent?.selected_billing_cadence, 20)})`,
    `Initial payment: USD ${(Math.max(0, Number(intent?.initial_payment_cents || 0)) / 100).toFixed(2)}`,
    `Discount: USD ${(discountCents / 100).toFixed(2)}`,
    `Activated: ${clean(intent?.activated_at, 80)}`,
    `alphaScreen sale: ${clean(intent?.id, 80)}`,
    `GHL opportunity: ${clean(binding?.opportunity_id, 160)}`,
  ];
  return lines.join('\n').slice(0, 4000);
}

async function ensureGhlWinNote(delivery, intent, binding, agreement, options = {}) {
  const marker = `[alphaScreen sync:${clean(delivery?.id, 80)}]`;
  const path = `/contacts/${encodeURIComponent(binding.contact_id)}/notes`;
  const notesBody = await ghlRequest(path, options);
  const notes = Array.isArray(notesBody?.notes) ? notesBody.notes : [];
  if (notes.some((note) => clean(note?.body, 5000).includes(marker))) {
    return { created: false, noteId: clean(notes.find((note) => clean(note?.body, 5000).includes(marker))?.id, 160) || null };
  }
  const body = await ghlRequest(path, {
    ...options,
    method: 'POST',
    body: {
      userId: binding.provider_owner_user_id,
      title: 'alphaScreen activation',
      body: buildGhlWinNote({ delivery, intent, binding, agreement }),
      pinned: false,
    },
  });
  return { created: true, noteId: clean(body?.note?.id, 160) || null };
}

async function markGhlOpportunityWon(delivery, context, options = {}) {
  const env = options.env || process.env;
  const config = ghlSalesConfiguration(env);
  if (!config.configured || !config.syncEnabled) {
    throw integrationError('ghl_sales_sync_disabled', 'GHL sales synchronization is disabled or incomplete.', {
      status: 503,
      retryable: true,
    });
  }
  const { intent, binding, agreement } = context;
  if (!binding?.id || clean(binding.location_id, 160) !== config.locationId || clean(binding.opportunity_id, 160) !== clean(intent?.ghl_opportunity_id, 160)) {
    throw integrationError('ghl_binding_mismatch', 'The alphaScreen sale does not match its GHL opportunity binding.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  const requestOptions = { env, fetchImpl: options.fetchImpl, config };
  const opportunity = await fetchGhlOpportunity(binding.opportunity_id, requestOptions);
  assertOpportunityBoundary(opportunity, config);
  if (clean(opportunity?.contactId || opportunity?.contact_id, 160) !== clean(binding.contact_id, 160)) {
    throw integrationError('ghl_contact_changed', 'The mapped GHL opportunity now points to another contact.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  if (clean(opportunity?.assignedTo || opportunity?.assigned_to, 160) !== clean(binding.provider_owner_user_id, 160)) {
    throw integrationError('ghl_owner_changed', 'The mapped GHL opportunity owner changed after import.', {
      status: 409,
      retryable: false,
      manualReview: true,
    });
  }
  if (clean(opportunity?.status, 40).toLowerCase() !== 'won') {
    assertOpportunityBoundary(opportunity, config, { requireReadyStage: true, rejectClosed: true });
    const result = await ghlRequest(`/opportunities/${encodeURIComponent(binding.opportunity_id)}/status`, {
      ...requestOptions,
      method: 'PUT',
      body: { status: 'won' },
    });
    if (result?.success !== true && result?.succeded !== true) {
      throw integrationError('ghl_won_not_confirmed', 'GHL did not confirm the Won status update.');
    }
  }
  const note = await ensureGhlWinNote(delivery, intent, binding, agreement, requestOptions);
  return {
    opportunityId: binding.opportunity_id,
    contactId: binding.contact_id,
    noteId: note.noteId,
    noteCreated: note.created,
  };
}

function webhookBodyDigest(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function timingSafeSecret(actual, expected) {
  const actualDigest = crypto.createHash('sha256').update(String(actual || '')).digest();
  const expectedDigest = crypto.createHash('sha256').update(String(expected || '')).digest();
  return Boolean(expected) && crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function verifyGhlEd25519Signature(rawBody, signature, publicKey) {
  if (!signature || !publicKey) return false;
  try {
    const signatureBuffer = Buffer.from(String(signature).trim(), 'base64');
    const key = String(publicKey).includes('BEGIN PUBLIC KEY')
      ? String(publicKey).replace(/\\n/g, '\n')
      : crypto.createPublicKey({
        key: Buffer.from(String(publicKey).trim(), 'base64'),
        format: 'der',
        type: 'spki',
      });
    return crypto.verify(null, rawBody, key, signatureBuffer);
  } catch {
    return false;
  }
}

module.exports = {
  assertOpportunityBoundary,
  buildGhlWinNote,
  clean,
  fetchGhlContact,
  fetchGhlOpportunity,
  ghlRequest,
  ghlSalesConfiguration,
  importReadyGhlOpportunity,
  integrationError,
  markGhlOpportunityWon,
  recordGhlSyncEvent,
  requireId,
  resolveActiveSalesRep,
  timingSafeSecret,
  upsertGhlBinding,
  verifyGhlEd25519Signature,
  verifyReadyGhlBinding,
  webhookBodyDigest,
};
