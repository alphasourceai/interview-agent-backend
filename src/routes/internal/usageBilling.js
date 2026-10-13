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

const router = express.Router();

// PostgREST caps a response at 1,000 rows by default, so both lookups below page
// rather than silently billing only the first page once there are more usage
// clients than that. Each page is ordered, without which range paging can repeat
// or skip rows.
const PAGE_SIZE = 500;
// An `in` filter becomes a query string, so the id list is sent in chunks rather
// than as one very long URL.
const ID_CHUNK_SIZE = 200;
// A stop so a backend that never returns a short page cannot spin forever.
const MAX_PAGES = 200;

async function readAllPages(buildQuery, { requireExactCount = false } = {}) {
  const rows = [];
  let expectedCount;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error, count } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { rows: null, error };
    if (requireExactCount && (!Number.isSafeInteger(count) || count < 0
      || (expectedCount !== undefined && expectedCount !== count))) {
      return { rows: null, error: { message: 'enterprise_usage_owner_census_unavailable' } };
    }
    if (requireExactCount) expectedCount = count;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      if (requireExactCount && (rows.length !== expectedCount || new Set(rows.map(r => r.id)).size !== rows.length))
        return { rows: null, error: { message: 'enterprise_usage_owner_census_unavailable' } };
      return { rows, error: null };
    }
  }
  console.warn('usage_billing_cron_page_limit_reached', { page_size: PAGE_SIZE, max_pages: MAX_PAGES });
  return requireExactCount ? { rows: null, error: { message: 'enterprise_usage_owner_census_unavailable' } } : { rows, error: null };
}

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

  // Enterprise bills on the 1st. Monthly clients are covered by the
  // invoice.created hook; this exists only for annual ones, whose platform-fee
  // invoice appears once a year. Scheduling stays daily and the handler decides,
  // so a missed day is a missed run rather than a missed month.
  if (now.getUTCDate() !== 1) {
    console.log('usage_billing_cron_not_due', { request_id: requestId, utc_day: now.getUTCDate() })
    return res.json({ ok: true, skipped: 'not_first_of_month', considered: 0, invoiced: 0, skipped_clients: 0, failed: 0, total_cents: 0, results: [] })
  }

  try {
    // A null billing_model means "follow the plan tier", so filtering the column
    // for 'usage' in SQL would miss every Enterprise client left on its tier's
    // model. The rows are resolved with the same rule resolveBillingModel uses.
    const { rows: settings, error: settingsError } = await readAllPages(() => supabaseAdmin
      .from('client_plan_settings')
      .select('client_id,plan_tier,billing_model')
      .order('client_id', { ascending: true }))
    if (settingsError) {
      return res.status(500).json({ error: 'usage_clients_lookup_failed', detail: settingsError.message })
    }

    const markers = ['enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices',
      'enterprise_funding_receipt','enterprise_billing_receipt'];
    const markedScan = await readAllPages(() => supabaseAdmin.from('membership_agreements')
      .select(['id','client_id',...markers].join(','), { count: 'exact' }).order('id', { ascending: true }), { requireExactCount: true });
    if (markedScan.error || markedScan.rows.some(a => !a.id || !a.client_id))
      return res.status(503).json({ error: 'billing_unavailable', code: 'enterprise_usage_terms_unavailable' });
    const markedIds = new Set(markedScan.rows.filter(a => markers.some(k => a[k] != null)).map(a => String(a.client_id)));
    const usageSettings = (settings || [])
      .filter((row) => normalizeBillingModel(row?.billing_model, row?.plan_tier) === 'usage')
    const clientIds = [...new Set([...usageSettings.map((row) => String(row?.client_id || '')).filter(Boolean), ...markedIds])]
    if (!clientIds.length) {
      console.log('usage_billing_cron_summary', { request_id: requestId, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0 })
      return res.json({ ok: true, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0, results: [] })
    }

    const clients = []
    for (const idChunk of chunk(clientIds, ID_CHUNK_SIZE)) {
      const { rows, error: clientsError } = await readAllPages(() => supabaseAdmin
        .from('clients')
        .select('id,name,billing_interval,stripe_customer_id,contract_start_at,current_term_end')
        .in('id', idChunk)
        .order('id', { ascending: true }))
      if (clientsError) {
        return res.status(500).json({ error: 'usage_clients_lookup_failed', detail: clientsError.message })
      }
      clients.push(...rows.filter(c => c.billing_interval === 'annual' || markedIds.has(String(c.id))))
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

    return res.json({ ok: true, considered: due.length, invoiced, skipped, failed, total_cents: totalCents, results })
  } catch (e) {
    return res.status(500).json({ error: 'usage_invoices_failed', detail: e?.detail || e?.message || 'usage_invoices_failed' })
  }
})

module.exports = router;
