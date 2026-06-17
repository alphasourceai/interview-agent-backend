'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateClientEntityImportRows } = require('../src/lib/clientEntityImport');

test('client entity import validation trims rows and flags duplicates/errors', () => {
  const rows = validateClientEntityImportRows([
    { name: ' Castle Rock Office ', location_type: ' Office ', location_user_email: 'manager@example.com', member_role: 'Manager' },
    { name: 'Castle Rock Office', location_type: 'Office', location_user_email: '', member_role: '' },
    { name: 'Denver Office', location_type: '', location_user_email: 'bad-email', member_role: 'Member' },
    { name: ' ', location_type: '', location_user_email: '', member_role: '' },
  ]);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Castle Rock Office');
  assert.equal(rows[0].location_type, 'office');
  assert.equal(rows[0].member_role, 'manager');
  assert.match(rows[0].errors.join(' '), /Duplicate entity name/);
  assert.match(rows[1].errors.join(' '), /Duplicate entity name/);
  assert.match(rows[2].errors.join(' '), /valid email/);
});

test('client entity import validation skips existing child entity names', () => {
  const rows = validateClientEntityImportRows([
    { name: 'Existing Office', location_type: 'Office', location_user_email: '', member_role: '' },
    { name: 'New Office', location_type: '', location_user_email: 'member@example.com', member_role: 'Member' },
  ], {
    existingNames: ['existing office'],
  });

  assert.equal(rows[0].skip_reason, 'duplicate_existing_entity');
  assert.deepEqual(rows[0].errors, []);
  assert.equal(rows[1].member_role, 'member');
  assert.match(rows[1].warnings.join(' '), /not created/);
});
