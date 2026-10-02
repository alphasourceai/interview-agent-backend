'use strict';

// This gate is intentionally independent of APP_ENV/NODE_ENV. A missing or
// misspelled environment designation must never enable sales side effects.
function salesProductionWritesEnabled(env = process.env) {
  return env.SALES_PRODUCTION_WRITES_ENABLED === 'true';
}

function requireSalesProductionWrites(env = process.env) {
  return (_req, res, next) => {
    if (salesProductionWritesEnabled(env)) return next();
    return res.status(503).json({ error: 'sales_promotion_disabled' });
  };
}

function requireSalesProductionMutation(env = process.env) {
  const requireWrites = requireSalesProductionWrites(env);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return requireWrites(req, res, next);
  };
}

module.exports = {
  requireSalesProductionMutation,
  requireSalesProductionWrites,
  salesProductionWritesEnabled,
};
