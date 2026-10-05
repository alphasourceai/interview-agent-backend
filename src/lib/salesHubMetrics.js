'use strict'
const { formatInTimeZone, fromZonedTime } = require('date-fns-tz')

async function exactCount(query) {
  const result = await query
  if (result.error || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error('sales_hub_metrics_unavailable')
  return result.count
}

async function salesHubMetrics(db, now = new Date()) {
  const generatedAt = now.toISOString()
  const month = formatInTimeZone(now, 'America/Denver', 'yyyy-MM')
  const monthStart = fromZonedTime(`${month}-01T00:00:00`, 'America/Denver').toISOString()
  const intents = () => db.from('public_purchase_intents').select('id', { count: 'exact', head: true }).eq('channel', 'sales_assisted')
  const wins = () => intents().eq('status', 'completed').not('activated_at', 'is', null).lte('activated_at', generatedAt)
  const [ready, in_progress, activated, activated_mtd] = await Promise.all([
    exactCount(db.from('ghl_sales_deal_bindings').select('id', { count: 'exact', head: true })
      .eq('status', 'ready').is('purchase_intent_id', null).eq('manual_review_required', false)),
    exactCount(intents().in('status', ['pending', 'agreement_pending', 'checkout_pending'])),
    exactCount(wins()),
    exactCount(wins().gte('activated_at', monthStart)),
  ])
  return { ready, in_progress, activated, activated_mtd, generated_at: generatedAt }
}

module.exports = { salesHubMetrics }
