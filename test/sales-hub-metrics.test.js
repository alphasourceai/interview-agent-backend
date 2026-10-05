'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { salesHubMetrics } = require('../src/lib/salesHubMetrics')

function fakeDb(result = { count: 4, error: null }) {
  const calls = []
  return { calls, from(table) {
    const call = { table, filters: [] }; calls.push(call)
    const q = {
      select(column, options) { call.column = column; call.options = options; return q },
      eq(...v) { call.filters.push(['eq', ...v]); return q },
      is(...v) { call.filters.push(['is', ...v]); return q },
      not(...v) { call.filters.push(['not', ...v]); return q },
      in(...v) { call.filters.push(['in', ...v]); return q },
      lte(...v) { call.filters.push(['lte', ...v]); return q },
      gte(...v) { call.filters.push(['gte', ...v]); return q },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
    }; return q
  } }
}
test('team metrics are exact head-only aggregates with no records, money, identities or routing', async () => {
  const db = fakeDb({ count: 4, data: [{ email: 'must-not-escape@example.com' }], error: null })
  const data = await salesHubMetrics(db, new Date('2026-10-05T15:00:00Z'))
  assert.deepEqual(data, { ready: 4, in_progress: 4, activated: 4, activated_mtd: 4, generated_at: '2026-10-05T15:00:00.000Z' })
  for (const c of db.calls) { assert.equal(c.column, 'id'); assert.deepEqual(c.options, { count: 'exact', head: true }) }
  assert.ok(db.calls.slice(1).every(c=>c.filters.some(f=>f[1]==='channel' && f[2]==='sales_assisted')))
  assert.ok(db.calls[0].filters.some(f=>f[1]==='manual_review_required' && f[2]===false))
  assert.ok(db.calls[2].filters.some(f=>f[0]==='not' && f[1]==='activated_at'))
})
test('month starts at Denver midnight, including UTC month boundary and winter offset', async () => {
  for (const [instant, expected] of [['2026-10-01T04:00:00Z','2026-09-01T06:00:00.000Z'], ['2026-12-10T12:00:00Z','2026-12-01T07:00:00.000Z']]) {
    const db = fakeDb(); await salesHubMetrics(db, new Date(instant))
    assert.deepEqual(db.calls[3].filters.find(f=>f[0]==='gte'), ['gte','activated_at',expected])
  }
})
test('database errors or missing/invalid counts fail closed with no partial totals', async () => {
  for (const result of [{ count: 1, error: { code: 'db' } }, { count: null }, { count: -1 }, { count: 1.5 }]) {
    await assert.rejects(salesHubMetrics(fakeDb(result)), /sales_hub_metrics_unavailable/)
  }
})
