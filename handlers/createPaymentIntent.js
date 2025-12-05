'use strict';

const stripe = require('../lib/stripeClient');

async function createPaymentIntent(req, res) {
  try {
    const { amount, currency, description } = req.body || {};

    const amountNumber = Number(amount);
    if (!amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({
        error: 'invalid_amount',
        code: 'VALIDATION_ERROR',
        detail: 'Amount is required and must be a positive number.',
        hint: 'Pass amount in dollars as a positive number.',
        request_id: req.request_id || null
      });
    }

    const amountInCents = Math.round(amountNumber * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency || 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { description: description || '' }
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Stripe payment intent error', error);
    return res.status(500).json({
      error: 'payment_intent_creation_failed',
      code: 'PAYMENT_INTENT_ERROR',
      detail: error?.message || 'Failed to create payment intent',
      hint: 'Check Stripe logs and STRIPE_SECRET_KEY configuration.',
      request_id: req.request_id || null
    });
  }
}

module.exports = { createPaymentIntent };
