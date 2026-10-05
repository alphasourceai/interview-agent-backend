'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { salesRepProfile } = require('../src/lib/salesRepProfile')

function dbFixture({ failedTable, inactive = false, unassigned = false } = {}) {
  const tables = {
    sales_team_members: [{ id: 'member-a', sales_rep_user_id: 'a', status: inactive ? 'inactive' : 'active', mobile_phone_e164: '+13035550111' }, { id: 'member-b', sales_rep_user_id: 'b', status: 'active' }],
    sales_phone_assignments: [{ team_member_id: 'member-a', phone_number_id: 'line-a', status: unassigned ? 'draft' : 'active', handoff_token_sha256: 'secret' }, { team_member_id: 'member-b', phone_number_id: 'line-b', status: 'active' }],
    sales_phone_numbers: [{ id: 'line-a', e164: '+17205550123', active: true }, { id: 'line-b', e164: '+17195550124', active: true }],
  }
  return { from(table) {
    const filters = []
    let columns = []
    return {
      select(value) { columns = value.split(','); return this },
      eq(key, value) { filters.push([key, value]); return this },
      async maybeSingle() {
        if (table === failedTable) return { error: { code: 'unavailable' } }
        const row = tables[table].find(r => filters.every(([key, value]) => r[key] === value))
        return { data: row ? Object.fromEntries(columns.map(key => [key, row[key]])) : null, error: null }
      },
    }
  } }
}
const rep = user_id => ({ user_id, email: `${user_id}@example.com`, display_name: user_id, access_role: 'sales_rep' })
test('each rep gets only their assigned public business phone', async () => {
  const a = await salesRepProfile(rep('a'), dbFixture())
  const b = await salesRepProfile(rep('b'), dbFixture())
  assert.equal(a.business_phone_e164, '+17205550123')
  assert.equal(b.business_phone_e164, '+17195550124')
  assert.deepEqual(Object.keys(a).sort(), ['access_role', 'business_phone_e164', 'display_name', 'email', 'user_id'])
})
test('inactive or unassigned roster entries never borrow another line', async () => {
  assert.equal((await salesRepProfile(rep('a'), dbFixture({ inactive: true }))).business_phone_e164, null)
  assert.equal((await salesRepProfile(rep('a'), dbFixture({ unassigned: true }))).business_phone_e164, null)
})
test('global admin receives no representative line and no roster query', async () => {
  assert.equal((await salesRepProfile({ ...rep('a'), access_role: 'global_admin' }, { from() { assert.fail('must not query roster') } })).business_phone_e164, null)
})
test('failed scoped reads fail closed instead of displaying stale profile data', async () => {
  for (const table of ['sales_team_members', 'sales_phone_assignments', 'sales_phone_numbers']) {
    await assert.rejects(salesRepProfile(rep('a'), dbFixture({ failedTable: table })), /sales_profile_unavailable/)
  }
})
