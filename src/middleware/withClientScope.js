// src/middleware/withClientScope.js
// Compatibility shim: always re-export from ./auth
const { withClientScope, requireAuth } = require('./auth');
module.exports = { withClientScope, requireAuth };
