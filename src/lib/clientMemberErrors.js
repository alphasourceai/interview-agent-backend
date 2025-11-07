function normalizeMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err.toLowerCase();
  return String(
    err.message ||
    err.details?.message ||
    err.error_description ||
    err.error ||
    err.toString() ||
    ''
  ).toLowerCase();
}

function isDuplicateAuthError(err) {
  const code = err?.code || err?.status || err?.statusCode;
  if (String(code) === '409') return true;
  const msg = normalizeMessage(err);
  if (!msg) return false;
  return (
    msg.includes('already registered') ||
    msg.includes('already exists') ||
    msg.includes('duplicate user')
  );
}

function isDuplicateDbError(err) {
  const sqlState = err?.code || err?.details?.code;
  if (String(sqlState) === '23505') return true;
  const msg = normalizeMessage(err);
  if (!msg) return false;
  return (
    msg.includes('duplicate key') ||
    msg.includes('unique constraint') ||
    msg.includes('already exists')
  );
}

function isRlsViolationError(err) {
  const msg = normalizeMessage(err);
  if (!msg) return false;
  return msg.includes('row-level security') || msg.includes('rls');
}

const EMAIL_IN_USE_RESPONSE = {
  error: 'email_in_use',
  detail: 'Email is already associated with another member.'
};

const DUPLICATE_MEMBER_RESPONSE = {
  error: 'duplicate_member',
  detail: 'User is already a member of this client.'
};

module.exports = {
  normalizeMessage,
  isDuplicateAuthError,
  isDuplicateDbError,
  isRlsViolationError,
  EMAIL_IN_USE_RESPONSE,
  DUPLICATE_MEMBER_RESPONSE
};
