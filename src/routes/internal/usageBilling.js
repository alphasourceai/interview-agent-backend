'use strict';

// Cron entry point for annual Enterprise usage invoices. Guarded by a shared
// secret header rather than a user session, because the caller is the scheduler.
//
// Monthly Enterprise clients need nothing here: their usage is added to the
// platform-fee invoice each cycle by the invoice.created webhook. An annual
// client only gets that invoice once a year, so their usage is raised as its own
// invoice on the 1st of each month.

const express = require('express');

const { supabaseAdmin } = require('../../clients/supabase');
const { createImmediateUsageInvoice } = require('../../services/usageBilling');
const { normalizeBillingModel } = require('../../services/billingModel');
const { secretsMatch } = require('../../services/secretCompare');
const { readAllPages, validKey, CODE: CENSUS_CODE } = require('../../services/enterpriseUsageOwnerCensus');

const router = express.Router();

// An `in` filter becomes a query string, so the id list is sent in chunks rather
// than as one very long URL.
const ID_CHUNK_SIZE = 200;

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

router.post('/billing/usage-invoices', async (req, res) => {
  const expectedSecret = String(process.env.USAGE_BILLING_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!secretsMatch(providedSecret, expectedSecret)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const requestId = req.request_id || null
  const now = new Date()
  const unavailableCensus = () => {
    console.warn('usage_billing_cron_held', { request_id: requestId, code: CENSUS_CODE })
    return res.status(503).json({ error: 'billing_unavailable', code: CENSUS_CODE })
  }

  try {
    // One complete agreement census on EVERY day. A non-null marker is a hold
    // boundary, not certification of an accepted receipt or executable owner.
    const markers = ['enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices',
      'enterprise_funding_receipt','enterprise_billing_receipt'];
    const markedScan = await readAllPages(() => supabaseAdmin.from('membership_agreements')
      .select(['id','client_id',...markers].join(','), { count: 'exact' }).order('id', { ascending: true }));
    if (markedScan.error || markedScan.rows.some(a => !validKey(a.client_id))) return unavailableCensus();
    const markedIds = new Set(markedScan.rows.filter(a => markers.some(k => a[k] != null)).map(a => a.client_id));
    if (now.getUTCDate() !== 1) {
      if (markedIds.size) {
        const code = 'enterprise_usage_invoice_executor_pending';
        console.warn('usage_billing_cron_held', { request_id: requestId, code })
        return res.status(503).json({ ok: false, error: 'billing_unavailable', code,
          considered: markedIds.size, invoiced: 0, skipped_clients: 0, failed: markedIds.size,
          held_clients: markedIds.size, total_cents: 0, results: [] })
      }
      // Preserve the legacy day-1 policy; no settings/client/Stripe read here.
      console.log('usage_billing_cron_not_due', { request_id: requestId, utc_day: now.getUTCDate() })
      return res.json({ ok: true, skipped: 'not_first_of_month', considered: 0, invoiced: 0, skipped_clients: 0, failed: 0, total_cents: 0, results: [] })
    }

    // A null billing_model means "follow the plan tier", so filtering the column
    // for 'usage' in SQL would miss every Enterprise client left on its tier's
    // model. The rows are resolved with the same rule resolveBillingModel uses.
    const { rows: settings, error: settingsError } = await readAllPages(() => supabaseAdmin
      .from('client_plan_settings')
      .select('client_id,plan_tier,billing_model', { count: 'exact' })
      .order('client_id', { ascending: true }), { key: 'client_id' })
    if (settingsError) return unavailableCensus();
    const usageSettings = (settings || [])
      .filter((row) => normalizeBillingModel(row?.billing_model, row?.plan_tier) === 'usage')
    const clientIds = [...new Set([...usageSettings.map((row) => row.client_id), ...markedIds])]
    if (!clientIds.length) {
      console.log('usage_billing_cron_summary', { request_id: requestId, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0 })
      return res.json({ ok: true, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0, results: [] })
    }

    const clients = []
    for (const idChunk of chunk(clientIds, ID_CHUNK_SIZE)) {
      const { rows, error: clientsError } = await readAllPages(() => supabaseAdmin
        .from('clients')
        .select('id,name,billing_interval,stripe_customer_id,contract_start_at,current_term_end', { count: 'exact' })
        .in('id', idChunk)
        .order('id', { ascending: true }))
      if (clientsError) return unavailableCensus();
      clients.push(...rows.filter(c => c.billing_interval === 'annual' || markedIds.has(c.id)))
    }

    const due = clients

    // Required here rather than at the top of the file so that mounting this
    // router does not construct the Stripe client, the way the other routes that
    // reach Stripe do it.
    const stripe = require('../../clients/stripe')

    const results = []
    let invoiced = 0
    let skipped = 0
    let failed = 0
    let totalCents = 0
    const heldClients = new Set()

    for (const client of due) {
      // One client's failure must not stop the rest of the run.
      try {
        const result = await createImmediateUsageInvoice({
          db: supabaseAdmin,
          stripe,
          clientId: client.id,
          customerId: client.stripe_customer_id || null,
          asOf: now.toISOString(),
          requestId,
          reason: 'monthly_cycle',
          now: now.toISOString()
        })
        if (result.skipped) {
          skipped += 1
          results.push({ client_id: client.id, status: 'skipped', reason: result.reason || null })
          console.log('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'skipped', reason: result.reason || null })
        } else {
          invoiced += 1
          totalCents += Number(result.total_cents || 0)
          results.push({ client_id: client.id, status: 'invoiced', invoice_id: result.invoice_id, total_cents: result.total_cents })
          console.log('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'invoiced', invoice_id: result.invoice_id, total_cents: result.total_cents })
        }
      } catch (e) {
        failed += 1
        if (e?.status === 503 && ['enterprise_usage_invoice_executor_pending', 'enterprise_usage_terms_unavailable'].includes(e.code)) {
          heldClients.add(client.id)
        }
        results.push({ client_id: client.id, status: 'failed', error: e?.message || 'usage_invoice_failed',
          ...(e?.status === 503 ? { retryable: true, code: e.code, http_status: 503 } : {}) })
        console.error('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'failed', error: e?.message || String(e) })
      }
    }

    console.log('usage_billing_cron_summary', {
      request_id: requestId,
      considered: due.length,
      invoiced,
      skipped,
      failed,
      total_cents: totalCents
    })

    if (heldClients.size) {
      const code = results.some(r => r.http_status === 503 && r.code === 'enterprise_usage_invoice_executor_pending')
        ? 'enterprise_usage_invoice_executor_pending' : 'enterprise_usage_terms_unavailable';
      // Actual legacy invoice results remain visible; an aggregate hold does
      // not roll back provider effects or turn those results into paid cash.
      return res.status(503).json({ ok: false, error: 'billing_unavailable', code,
        considered: due.length, invoiced, skipped, failed, held_clients: heldClients.size, total_cents: totalCents, results })
    }
    return res.json({ ok: true, considered: due.length, invoiced, skipped, failed, total_cents: totalCents, results })
  } catch (e) {
    return res.status(500).json({ error: 'usage_invoices_failed', detail: e?.detail || e?.message || 'usage_invoices_failed' })
  }
})

module.exports = router;
