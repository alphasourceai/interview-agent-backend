'use strict';

const express = require('express');
const crypto = require('crypto');
const stripe = require('../lib/stripeClient');
const { supabaseAnon, supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();

const bearer = (req) => {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

async function requireAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const email = req.user?.email || null;
    if (!email) return res.status(403).json({ error: 'not_admin' });
    const { data: adm, error } = await supabaseAdmin
      .from('admins')
      .select('id,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.error('[billing] admin_lookup_failed', { request_id: req.request_id || null, error: error.message, code: error.code });
      return res.status(500).json({ error: 'admin_lookup_failed', code: error.code || 'admin_lookup_failed', detail: error.message, hint: error.hint, request_id: req.request_id || null });
    }
    if (!adm) return res.status(403).json({ error: 'not_admin' });
    next();
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed', code: 'admin_guard_failed', detail: e?.message || e });
  }
}

router.use(requireAuth, requireAdmin);

router.get('/customers', async (_req, res) => {
  const request_id = crypto.randomUUID?.() || String(Date.now());
  try {
    const { data, error } = await supabaseAdmin
      .from('billing_customers')
      .select('id,client_id,name,primary_contact_name,primary_contact_email,notes,stripe_customer_id,created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[billing/customers:list] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'list_customers_failed', code: error.code || 'list_customers_failed', detail: error.message, hint: error.hint, request_id });
    }
    return res.json({ items: data || [], request_id });
  } catch (e) {
    console.error('[billing/customers:list] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.post('/customers', async (req, res) => {
  const request_id = crypto.randomUUID?.() || String(Date.now());
  try {
    const name = (req.body?.company_name || req.body?.name || '').trim();
    const primary_contact_name = (req.body?.primary_contact_name || '').trim();
    const primary_contact_email = (req.body?.primary_contact_email || '').trim();
    const notes = (req.body?.notes || '').trim();
    const client_id = (req.body?.client_id || '').trim() || null;

    if (!name || !primary_contact_name || !primary_contact_email) {
      return res.status(400).json({ error: 'missing_fields', code: 'missing_fields', detail: 'name, primary_contact_name, primary_contact_email required', request_id });
    }

    const { data, error } = await supabaseAdmin
      .from('billing_customers')
      .insert({ name, primary_contact_name, primary_contact_email, notes: notes || null, client_id: client_id || null })
      .select('id,client_id,name,primary_contact_name,primary_contact_email,notes,stripe_customer_id,created_at')
      .single();

    if (error) {
      console.error('[billing/customers:create] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'create_customer_failed', code: error.code || 'create_customer_failed', detail: error.message, hint: error.hint, request_id });
    }

    return res.json({ item: data, request_id });
  } catch (e) {
    console.error('[billing/customers:create] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.get('/invoices', async (_req, res) => {
  const request_id = crypto.randomUUID?.() || String(Date.now());
  try {
    const { data, error } = await supabaseAdmin
      .from('billing_invoices')
      .select('id,billing_customer_id,title,invoice_description,amount_total,currency,status,hosted_invoice_url,stripe_invoice_id,created_at,customer_name,customer_email')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.error('[billing/invoices:list] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'list_invoices_failed', code: error.code || 'list_invoices_failed', detail: error.message, hint: error.hint, request_id });
    }
    return res.json({ items: data || [], request_id });
  } catch (e) {
    console.error('[billing/invoices:list] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.post('/invoices/send', async (req, res) => {
  const request_id = crypto.randomUUID?.() || String(Date.now());
  try {
    const billing_customer_id = req.body?.billing_customer_id || null;
    const title = (req.body?.title || '').trim();
    const invoice_description = (req.body?.invoice_description || '').trim() || null;
    const days_until_due = Number.isFinite(parseInt(req.body?.days_until_due, 10)) ? parseInt(req.body?.days_until_due, 10) : 7;
    const line_items = Array.isArray(req.body?.line_items) ? req.body.line_items : [];

    if (!billing_customer_id || !title) {
      return res.status(400).json({ error: 'missing_fields', code: 'missing_fields', detail: 'billing_customer_id and title are required', request_id });
    }

    const normalizedItems = line_items
      .map((li) => ({
        description: (li?.description || '').trim(),
        quantity: parseInt(li?.quantity, 10) || 1,
        unit_amount: parseFloat(li?.unit_amount)
      }))
      .filter((li) => li.description && !Number.isNaN(li.unit_amount) && li.unit_amount > 0 && li.quantity > 0);

    if (!normalizedItems.length) {
      return res.status(400).json({ error: 'invalid_line_items', code: 'invalid_line_items', detail: 'At least one valid line item is required', request_id });
    }

    const { data: billingCustomer, error: fetchErr } = await supabaseAdmin
      .from('billing_customers')
      .select('id,name,primary_contact_name,primary_contact_email,stripe_customer_id')
      .eq('id', billing_customer_id)
      .maybeSingle();

    if (fetchErr) {
      console.error('[billing/send] customer_lookup_failed', { request_id, error: fetchErr.message, code: fetchErr.code, hint: fetchErr.hint });
      return res.status(500).json({ error: 'customer_lookup_failed', code: fetchErr.code || 'customer_lookup_failed', detail: fetchErr.message, hint: fetchErr.hint, request_id });
    }
    if (!billingCustomer) {
      return res.status(404).json({ error: 'customer_not_found', code: 'customer_not_found', detail: 'Billing customer not found', request_id });
    }

    let stripeCustomerId = billingCustomer.stripe_customer_id || null;
    if (!stripeCustomerId) {
      try {
        const sc = await stripe.customers.create({
          name: billingCustomer.name || billingCustomer.primary_contact_name,
          email: billingCustomer.primary_contact_email,
          metadata: {
            billing_customer_id: billingCustomer.id,
            primary_contact_name: billingCustomer.primary_contact_name || ''
          }
        });
        stripeCustomerId = sc.id;
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingCustomer.id);
      } catch (e) {
        console.error('[billing/send] stripe_customer_failed', { request_id, error: e?.message || e });
        return res.status(500).json({ error: 'stripe_customer_failed', code: 'stripe_customer_failed', detail: e?.message || 'Stripe customer creation failed', request_id });
      }
    }

    try {
      for (const item of normalizedItems) {
        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          description: item.description,
          quantity: item.quantity,
          currency: 'usd',
          unit_amount: Math.round(item.unit_amount * 100)
        });
      }
    } catch (e) {
      console.error('[billing/send] invoice_items_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_items_failed', code: 'invoice_items_failed', detail: e?.message || 'Could not create invoice items', request_id });
    }

    let createdInvoice = null;
    try {
      createdInvoice = await stripe.invoices.create({
        customer: stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: days_until_due || 7,
        description: invoice_description || undefined,
        metadata: {
          billing_customer_id,
          title
        }
      });
    } catch (e) {
      console.error('[billing/send] invoice_create_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_create_failed', code: 'invoice_create_failed', detail: e?.message || 'Could not create invoice', request_id });
    }

    let sentInvoice = createdInvoice;
    try {
      const finalized = await stripe.invoices.finalizeInvoice(createdInvoice.id);
      sentInvoice = finalized;
      const sent = await stripe.invoices.sendInvoice(createdInvoice.id);
      sentInvoice = sent || finalized;
    } catch (e) {
      console.error('[billing/send] invoice_send_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_send_failed', code: 'invoice_send_failed', detail: e?.message || 'Could not send invoice', request_id });
    }

    const amount_total = normalizedItems.reduce((sum, li) => sum + (li.unit_amount * li.quantity), 0);

    try {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('billing_invoices')
        .insert({
          billing_customer_id,
          title,
          invoice_description: invoice_description || null,
          amount_total,
          currency: 'usd',
          status: sentInvoice?.status || null,
          hosted_invoice_url: sentInvoice?.hosted_invoice_url || null,
          stripe_invoice_id: sentInvoice?.id || null,
          customer_name: billingCustomer.name || null,
          customer_email: billingCustomer.primary_contact_email || null
        })
        .select('id,stripe_invoice_id,status,hosted_invoice_url,invoice_description')
        .single();

      if (insErr) {
        console.error('[billing/send] persist_failed', { request_id, error: insErr.message, code: insErr.code, hint: insErr.hint });
        return res.status(500).json({ error: 'persist_failed', code: insErr.code || 'persist_failed', detail: insErr.message, hint: insErr.hint, request_id });
      }

      return res.json({ ok: true, invoice: inserted, request_id });
    } catch (e) {
      console.error('[billing/send] unexpected_persist', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
    }
  } catch (e) {
    console.error('[billing/send] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

module.exports = router;
