'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { exactPaymentTime } = require('../src/services/existingEnterprisePaymentRows');
test('payment row time preserves original A across native offset/precision serialization', () => {
  const a = '2026-10-13T15:30:00.000Z';
  for (const row of ['2026-10-13T15:30:00+00:00', '2026-10-13T15:30:00.000000Z', '2026-10-13T09:30:00-06:00'])
    assert.equal(exactPaymentTime(row, a), true);
  for (const row of ['2026-10-13T15:30:00.000001Z', '2026-10-13T15:30:00.000100+00:00',
    '2026-10-13T15:30:00.001Z', '2026-10-13T15:30:01Z', 'INVALID', null])
    assert.equal(exactPaymentTime(row, a), false);
});
