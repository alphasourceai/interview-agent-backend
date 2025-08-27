// util/pg.js
function isPostgrestError(err, code) {
  return err && (err.code === code || err?.hint?.includes(code));
}
module.exports = { isPostgrestError };
