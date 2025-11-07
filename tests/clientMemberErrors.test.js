const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isDuplicateAuthError,
  isDuplicateDbError,
  isRlsViolationError,
  EMAIL_IN_USE_RESPONSE,
  DUPLICATE_MEMBER_RESPONSE
} = require('../src/lib/clientMemberErrors');

describe('client member duplicate detection', () => {
  test('happy path: non-duplicate errors do not trigger duplicate guard', () => {
    assert.equal(isDuplicateDbError({ code: '12345' }), false);
    assert.equal(isDuplicateAuthError({ message: 'some other failure' }), false);
    assert.equal(isRlsViolationError({ message: 'permitted action' }), false);
  });

  test('duplicate path: detects auth and db duplicate signals', () => {
    assert.equal(isDuplicateDbError({ code: '23505' }), true);
    assert.equal(isDuplicateDbError({ message: 'duplicate key value violates unique constraint' }), true);
    assert.equal(isDuplicateAuthError({ message: 'User already registered' }), true);
    assert.equal(isRlsViolationError({ message: 'violates row-level security policy for table "client_members"' }), true);
    assert.equal(EMAIL_IN_USE_RESPONSE.error, 'email_in_use');
    assert.ok(EMAIL_IN_USE_RESPONSE.detail.includes('already associated'));
    assert.equal(DUPLICATE_MEMBER_RESPONSE.error, 'duplicate_member');
    assert.ok(DUPLICATE_MEMBER_RESPONSE.detail.includes('already a member'));
  });
});
