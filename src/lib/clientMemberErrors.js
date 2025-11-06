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

const DUPLICATE_EMAIL_RESPONSE = {
  error: 'duplicate_email',
  message: 'This email is already in use. Choose a different email or remove the existing member first.'
};

module.exports = {
  normalizeMessage,
  isDuplicateAuthError,
  isDuplicateDbError,
  DUPLICATE_EMAIL_RESPONSE
};
