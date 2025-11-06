const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isDuplicateAuthError,
  isDuplicateDbError,
  DUPLICATE_EMAIL_RESPONSE
} = require('../src/lib/clientMemberErrors');

describe('client member duplicate detection', () => {
  test('happy path: non-duplicate errors do not trigger duplicate guard', () => {
    assert.equal(isDuplicateDbError({ code: '12345' }), false);
    assert.equal(isDuplicateAuthError({ message: 'some other failure' }), false);
  });

  test('duplicate path: detects auth and db duplicate signals', () => {
    assert.equal(isDuplicateDbError({ code: '23505' }), true);
    assert.equal(isDuplicateDbError({ message: 'duplicate key value violates unique constraint' }), true);
    assert.equal(isDuplicateAuthError({ message: 'User already registered' }), true);
    assert.equal(DUPLICATE_EMAIL_RESPONSE.error, 'duplicate_email');
    assert.ok(DUPLICATE_EMAIL_RESPONSE.message.includes('already in use'));
  });
});
