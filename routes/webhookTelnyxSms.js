'use strict';

const express = require('express');
const { recordOtpSmsDeliveryEvent } = require('../src/lib/otpChallenge');
const {
  TelnyxWebhookError,
  parseTelnyxWebhook,
  verifyTelnyxWebhook,
} = require('../src/lib/telnyxWebhook');

function createTelnyxSmsWebhookRouter({
  db = null,
  env = process.env,
  now = () => Date.now(),
  recordDeliveryEvent = recordOtpSmsDeliveryEvent,
  logger = null,
} = {}) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    const publicKey = String(env.TELNYX_WEBHOOK_PUBLIC_KEY || '').trim();
    if (!publicKey) return res.status(503).json({ ok: false });
    try {
      verifyTelnyxWebhook({
        rawBody: req.body,
        signature: req.get('telnyx-signature-ed25519'),
        timestamp: req.get('telnyx-timestamp'),
        publicKey,
        now: now(),
      });
      const event = parseTelnyxWebhook(req.body);
      if (event.ignored) return res.status(200).json({ ok: true });
      const selectedDb = db || require('../src/lib/supabaseClient').supabaseAdmin;
      const result = await recordDeliveryEvent(selectedDb, {
        provider: event.provider,
        providerMessageId: event.messageId,
        providerEventId: event.eventId,
        providerEventAt: event.occurredAt,
        deliveryStatus: event.status,
      });
      if (logger && typeof logger.info === 'function') {
        logger.info('sms_delivery_callback', {
          provider: 'telnyx',
          event_type: event.eventType,
          status: event.status,
          found: result.found === true,
          applied: result.applied === true,
          replayed: result.replayed === true,
        });
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (error instanceof TelnyxWebhookError) {
        const status = ['invalid_signature', 'stale_signature'].includes(error.code) ? 403 : 400;
        return res.status(status).json({ ok: false });
      }
      return res.status(503).json({ ok: false });
    }
  });
  return router;
}

const router = createTelnyxSmsWebhookRouter();
module.exports = router;
module.exports.createTelnyxSmsWebhookRouter = createTelnyxSmsWebhookRouter;
