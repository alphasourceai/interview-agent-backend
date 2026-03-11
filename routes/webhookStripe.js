// routes/webhookStripe.js
const express = require('express');
const Stripe = require('stripe');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function isUniqueViolation(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function pickId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

router.post('/', async (req, res) => {
  const request_id = req.request_id || null;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({
      error: 'bad_request',
      code: 'STRIPE_SIGNATURE_VERIFICATION_FAILED',
      detail: err?.message || 'Invalid signature',
      hint: null,
      request_id
    });
  }

  const eventObject = event?.data?.object || null;
  const { error: insertErr } = await supabaseAdmin
    .from('billing_events')
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: eventObject
    });

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return res.status(200).json({ ok: true });
    }
    return res.status(500).json({
      error: 'server_error',
      code: 'BILLING_EVENT_INSERT_FAILED',
      detail: insertErr.message,
      hint: insertErr.hint || null,
      request_id
    });
  }

  const markProcessed = async (processed_ok, errorText = null) => {
    await supabaseAdmin
      .from('billing_events')
      .update({
        processed_ok,
        error: errorText
      })
      .eq('stripe_event_id', event.id);
  };

  try {
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const customerId = pickId(eventObject?.customer);
      if (customerId) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          const subStatus = String(eventObject?.status || '').toLowerCase();
          const intervalRaw = String(
            eventObject?.items?.data?.[0]?.price?.recurring?.interval ||
            eventObject?.plan?.interval ||
            ''
          ).toLowerCase();
          const billingInterval =
            intervalRaw === 'month' ? 'monthly' :
            intervalRaw === 'year' ? 'annual' :
            null;
          const periodEnd =
            eventObject?.current_period_end ??
            eventObject?.items?.data?.[0]?.current_period_end ??
            null;
          const updates = {
            stripe_subscription_id: pickId(eventObject?.id) || pickId(eventObject?.subscription) || null,
            stripe_subscription_schedule_id: pickId(eventObject?.schedule) || null,
            subscription_status: subStatus || null,
            current_term_end: toIsoFromUnixSeconds(periodEnd),
            cancel_at_term_end: eventObject?.cancel_at_period_end === true,
            billing_interval: billingInterval
          };
          const { error: updateErr } = await supabaseAdmin
            .from('clients')
            .update(updates)
            .eq('id', client.id);
          if (updateErr) throw new Error(updateErr.message || 'Client update failed');
        }
      }
    } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
      const customerId = pickId(eventObject?.customer);
      if (customerId) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id,subscription_status')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          const subscriptionId = pickId(eventObject?.subscription);
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const subStatus = String(subscription?.status || '').toLowerCase();
            const intervalRaw = String(
              subscription?.items?.data?.[0]?.price?.recurring?.interval ||
              subscription?.plan?.interval ||
              ''
            ).toLowerCase();
            const billingInterval =
              intervalRaw === 'month' ? 'monthly' :
              intervalRaw === 'year' ? 'annual' :
              null;
            const currentTermEnd = toIsoFromUnixSeconds(subscription?.current_period_end);
            const cancelAtTermEnd = subscription?.cancel_at_period_end === true;
            const scheduleId = pickId(subscription?.schedule) || null;
            const { error: updateErr } = await supabaseAdmin
              .from('clients')
              .update({
                stripe_subscription_id: subscriptionId,
                stripe_subscription_schedule_id: scheduleId,
                subscription_status: subStatus || client.subscription_status || null,
                current_term_end: currentTermEnd,
                cancel_at_term_end: cancelAtTermEnd,
                billing_interval: billingInterval
              })
              .eq('id', client.id);
            if (updateErr) throw new Error(updateErr.message || 'Client update failed');
          }
        }
      }
    }

    await markProcessed(true, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    await markProcessed(false, String(err?.message || err || 'processing_failed'));
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
