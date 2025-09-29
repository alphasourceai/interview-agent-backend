// util/pg.js
function isPostgrestError(err, code) {
  return err && (err.code === code || err?.hint?.includes(code));
}
module.exports = { isPostgrestError };

// utils/pg.js
// Node Postgres pool + tiny helpers used by BE routes
const { Pool } = require('pg');

// Prefer DATABASE_URL, but fall back to common env names developers use
const connectionString =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;

if (!connectionString) {
  throw new Error('[pg] Missing DATABASE_URL/POSTGRES_URL/PG_URL in env');
}

// Render/Heroku-style PG requires TLS; allow self-signed in prod PaaS
const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[pg] idle client error', err);
});

function isPostgrestError(err, code) {
  return (
    !!err && (err.code === code || (err.hint && err.hint.includes && err.hint.includes(code)))
  );
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  isPostgrestError,
};