// src/middleware/requireAuth.js
// Compatibility shim: always re-export from ./auth
const { requireAuth, withClientScope } = require('./auth');
module.exports = { requireAuth, withClientScope };
