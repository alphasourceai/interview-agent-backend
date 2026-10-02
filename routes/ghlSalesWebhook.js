'use strict';

const crypto = require('node:crypto');
const express = require('express');
const {
  clean,
  ghlSalesConfiguration,
  importReadyGhlOpportunity,
  recordGhlSyncEvent,
  requireId,
  timingSafeSecret,
  verifyGhlEd25519Signature,
  webhookBodyDigest,
} = require('../src/lib/ghlSalesIntegration');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const MAX_BODY_BYTES = 64 * 1024;

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || '';
}

function webhookIdentifiers(body, headers = {}) {
  const opportunity = body?.opportunity || body?.data?.opportunity || body?.data || body || {};
  const opportunityId = requireId(pick(
    body?.opportunityId,
    body?.opportunity_id,
    opportunity?.id,
    opportunity?._id
  ), 'opportunity_id');
  const locationId = requireId(pick(
    body?.locationId,
    body?.location_id,
    opportunity?.locationId,
    opportunity?.location_id
  ), 'location_id');
  const suppliedEventKey = clean(pick(
    headers['x-ghl-webhook-id'],
    headers['x-webhook-id'],
    body?.webhookId,
    body?.eventId,
    body?.id
  ), 255);
  const fallbackSource = `${locationId}:${opportunityId}:${clean(body?.timestamp || body?.dateAdded, 80) || 'no-time'}`;
  const eventKey = suppliedEventKey
    ? `ghl:${crypto.createHash('sha256').update(suppliedEventKey).digest('hex')}`
    : `ghl-ready:${crypto.createHash('sha256').update(fallbackSource).digest('hex')}`;
  return { eventKey, locationId, opportunityId };
}

async function reserveReceipt(db, values) {
  const payload = {
    event_key: values.eventKey,
    body_sha256: values.bodyDigest,
    location_id: values.locationId,
    opportunity_id: values.opportunityId,
    event_type: 'ready_to_close',
    status: 'processing',
  };
  const { data, error } = await db.from('ghl_sales_webhook_receipts').insert(payload).select('*').maybeSingle();
  if (!error) return { receipt: data, replay: false };
  if (clean(error.code, 40) !== '23505') throw Object.assign(new Error('GHL receipt reservation failed'), { code: 'ghl_receipt_reservation_failed' });
  const { data: existing, error: lookupError } = await db
    .from('ghl_sales_webhook_receipts')
    .select('*')
    .eq('event_key', values.eventKey)
    .maybeSingle();
  if (lookupError || !existing) throw Object.assign(new Error('GHL receipt replay lookup failed'), { code: 'ghl_receipt_lookup_failed' });
  if (existing.body_sha256 !== values.bodyDigest) {
    throw Object.assign(new Error('GHL event key was reused with different content'), {
      code: 'ghl_event_key_reused', status: 409, retryable: false, manualReview: true,
    });
  }
  if (existing.status === 'completed') return { receipt: existing, replay: true };
  if (existing.status === 'processing' && Date.now() - Date.parse(existing.last_received_at || existing.first_received_at) < 10 * 60 * 1000) {
    return { receipt: existing, replay: true, processing: true };
  }
  const { data: retried, error: retryError } = await db.from('ghl_sales_webhook_receipts')
    .update({
      status: 'processing',
      attempt_count: Number(existing.attempt_count || 1) + 1,
      last_received_at: new Date().toISOString(),
      last_error_code: null,
      last_error_detail: null,
      completed_at: null,
    })
    .eq('id', existing.id)
    .eq('status', existing.status)
    .eq('last_received_at', existing.last_received_at)
    .select('*')
    .maybeSingle();
  if (retryError) throw Object.assign(new Error('GHL receipt retry failed'), { code: 'ghl_receipt_retry_failed' });
  if (!retried) return reserveReceipt(db, values);
  return { receipt: retried, replay: false };
}

async function finishReceipt(db, receipt, values) {
  const completed = values.status === 'completed';
  const { data, error } = await db.from('ghl_sales_webhook_receipts')
    .update({
      status: values.status,
      binding_id: values.bindingId || receipt.binding_id || null,
      completed_at: completed ? new Date().toISOString() : null,
      last_received_at: new Date().toISOString(),
      last_error_code: clean(values.errorCode, 80) || null,
      last_error_detail: clean(values.errorDetail, 500) || null,
    })
    .eq('id', receipt.id)
    .eq('status', 'processing')
    .eq('attempt_count', receipt.attempt_count)
    .eq('last_received_at', receipt.last_received_at)
    .select('id')
    .maybeSingle();
  if (error) throw Object.assign(new Error('GHL receipt completion failed'), { code: 'ghl_receipt_completion_failed' });
  if (!data) throw Object.assign(new Error('GHL receipt processing ownership changed'), { code: 'ghl_receipt_ownership_lost' });
}

function authenticateWebhook(req, rawBody, env) {
  const expectedSecret = clean(env.GHL_SALES_WEBHOOK_SECRET, 1000);
  const authorization = clean(req.get('authorization'), 1200);
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const suppliedSecret = clean(req.get('x-alphasource-ghl-secret') || bearer, 1000);
  if (!timingSafeSecret(suppliedSecret, expectedSecret)) return { ok: false, status: 401, code: 'unauthorized' };

  const signature = clean(req.get('x-ghl-signature'), 2000);
  const publicKey = String(env.GHL_WEBHOOK_PUBLIC_KEY || '').trim().slice(0, 8000);
  const requireSignature = clean(env.GHL_WEBHOOK_REQUIRE_SIGNATURE, 10).toLowerCase() === 'true';
  if ((signature || requireSignature) && !verifyGhlEd25519Signature(rawBody, signature, publicKey)) {
    return { ok: false, status: 401, code: 'invalid_signature' };
  }
  return { ok: true };
}

function createGhlSalesWebhookRouter(options = {}) {
  const router = express.Router();
  const db = options.db || supabaseAdmin;
  const env = options.env || process.env;
  const logger = options.logger || console;
  const importer = options.importer || importReadyGhlOpportunity;

  router.post('/sales-ready', express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const auth = authenticateWebhook(req, rawBody, env);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.code });
    if (!rawBody.length) return res.status(400).json({ error: 'invalid_webhook_payload' });

    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_webhook_payload' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'invalid_webhook_payload' });

    let identifiers;
    try { identifiers = webhookIdentifiers(body, req.headers || {}); } catch (error) {
      return res.status(Number(error?.status) || 400).json({ error: clean(error?.code, 80) || 'invalid_webhook_payload' });
    }
    const config = ghlSalesConfiguration(env);
    if (!config.locationId || identifiers.locationId !== config.locationId) {
      return res.status(403).json({ error: 'ghl_location_not_allowed' });
    }
    const bodyDigest = webhookBodyDigest(rawBody);
    let receipt;
    try {
      const reservation = await reserveReceipt(db, { ...identifiers, bodyDigest });
      receipt = reservation.receipt;
      if (reservation.replay) {
        if (reservation.processing) {
          return res.status(503).json({
            error: 'ghl_receipt_processing',
            replayed: true,
          });
        }
        return res.status(200).json({ ok: true, replayed: true, status: 'completed', binding_id: receipt.binding_id || null });
      }

      const imported = await importer(identifiers.opportunityId, { db, env, fetchImpl: options.fetchImpl });
      await finishReceipt(db, receipt, { status: 'completed', bindingId: imported.binding.id });
      await recordGhlSyncEvent(db, {
        bindingId: imported.binding.id,
        direction: 'inbound',
        eventType: 'ready_to_close_imported',
        idempotencyKey: `inbound:${identifiers.eventKey}:completed`,
        status: 'completed',
        safeMetadata: {
          location_id: identifiers.locationId,
          opportunity_id: identifiers.opportunityId,
          created: imported.created === true,
        },
      });
      return res.status(imported.created ? 201 : 200).json({
        ok: true,
        replayed: false,
        status: imported.binding.status,
        binding_id: imported.binding.id,
      });
    } catch (error) {
      const code = clean(error?.code, 80) || 'ghl_sales_import_failed';
      if (code === 'ghl_receipt_ownership_lost') {
        return res.status(503).json({ error: code });
      }
      const detail = clean(error?.message, 500) || 'The GHL sales import failed.';
      const bindingId = error?.bindingId || null;
      if (receipt?.id) {
        try { await finishReceipt(db, receipt, { status: 'failed', bindingId, errorCode: code, errorDetail: detail }); } catch (_) {}
      }
      try {
        await recordGhlSyncEvent(db, {
          bindingId,
          direction: 'inbound',
          eventType: 'ready_to_close_import_failed',
          idempotencyKey: `inbound:${identifiers.eventKey}:failed:${code}`,
          status: error?.manualReview ? 'manual_review' : 'failed',
          safeMetadata: { location_id: identifiers.locationId, opportunity_id: identifiers.opportunityId },
          errorCode: code,
          errorDetail: detail,
        });
      } catch (_) {}
      logger.warn?.('[ghl-sales-webhook] import_failed', {
        request_id: req.request_id || null,
        opportunity_id: identifiers.opportunityId,
        code,
        retryable: error?.retryable !== false,
      });
      if (error?.manualReview) {
        return res.status(202).json({ ok: true, status: 'manual_review', binding_id: bindingId, code });
      }
      return res.status(error?.retryable === false ? (Number(error?.status) || 409) : 503).json({ error: code });
    }
  });

  return router;
}

module.exports = {
  authenticateWebhook,
  createGhlSalesWebhookRouter,
  finishReceipt,
  reserveReceipt,
  webhookIdentifiers,
};
