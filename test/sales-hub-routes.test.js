'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const express = require('express')
const http = require('node:http')
const clientPath = require.resolve('../src/lib/supabaseClient')
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { supabaseAdmin: {} } }
const { createSalesRouter } = require('../routes/sales')
const { createRequireSalesRep } = require('../src/middleware/salesAuth')

function fakeDb(failCounts = false) {
  const rows = {
    sales_reps: ['a', 'b'].map(id => ({ user_id: id, email: `${id}@example.com`, display_name: id, active: true })),
    admins: [{ id: 'admin', email: 'admin@example.com', is_active: true }],
    sales_team_members: [{ id: 'team-a', sales_rep_user_id: 'a', status: 'active' }],
    sales_phone_assignments: [{ team_member_id: 'team-a', phone_number_id: 'phone-a', status: 'active' }],
    sales_phone_numbers: [{ id: 'phone-a', e164: '+17205550101', active: true }],
  }
  return { from(table) {
    const filters = []
    const q = {
      select() { return q }, eq(k, v) { filters.push([k, v]); return q },
      is() { return q }, not() { return q }, in() { return q }, lte() { return q }, gte() { return q },
      async maybeSingle() { return { data: (rows[table] || []).find(row => filters.every(([k,v]) => row[k] === v)) || null, error: null } },
      then(resolve, reject) { return Promise.resolve({ count: failCounts ? null : 2, error: failCounts ? { message: 'private database failure' } : null }).then(resolve, reject) },
    }
    return q
  } }
}
async function request(identity, path, fail = false) {
  const db = fakeDb(fail)
  const app = express()
  app.use((req, _res, next) => { if (identity) req.user = { id: identity, email: `${identity}@example.com` }; next() })
  app.use('/sales', createRequireSalesRep({ db }), createSalesRouter({ db }))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`)
    return { status: response.status, body: await response.json() }
  } finally { await new Promise(resolve => server.close(resolve)) }
}
test('authenticated active reps and admin receive team aggregates only; caller scope is ignored', async () => {
  for (const id of ['a', 'b', 'admin']) {
    const result = await request(id, '/sales/hub-metrics?user_id=other&include=customers')
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), ['activated','activated_mtd','generated_at','in_progress','ready'])
    assert.equal(result.body.ready, 2)
    assert.equal(JSON.stringify(result.body).includes('example.com'), false)
  }
})
test('hub rejects unauthenticated and inactive users and returns no partial metrics on failure', async () => {
  assert.equal((await request(null, '/sales/hub-metrics')).status, 401)
  assert.equal((await request('inactive', '/sales/hub-metrics')).status, 403)
  const result = await request('a', '/sales/hub-metrics', true)
  assert.equal(result.status, 503)
  assert.equal('ready' in result.body, false)
  assert.equal(JSON.stringify(result.body).includes('private database'), false)
})
test('me ignores another-user query, reports own active business line and never borrows a line', async () => {
  const a = await request('a', '/sales/me?user_id=b')
  assert.equal(a.body.user_id, 'a')
  assert.equal(a.body.business_phone_e164, '+17205550101')
  assert.equal((await request('b', '/sales/me?user_id=a')).body.business_phone_e164, null)
  assert.equal((await request('admin', '/sales/me')).body.business_phone_e164, null)
})
