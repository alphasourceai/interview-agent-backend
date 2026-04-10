'use strict';

function normalizeBase(value, fallback) {
  const raw = String(value || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  return String(fallback || '').trim().replace(/\/+$/, '');
}

function withParams(url, params) {
  if (!params) return url;
  const search = params instanceof URLSearchParams
    ? params.toString()
    : new URLSearchParams(params).toString();
  return search ? `${url}?${search}` : url;
}

const CLIENT_AUTH_FRONTEND_BASE = normalizeBase(
  process.env.CLIENT_APP_BASE ||
    process.env.CLIENT_AUTH_FRONTEND_BASE ||
    process.env.FRONTEND_BASE ||
    process.env.FRONTEND_URL,
  'https://app.alphasourceai.com'
);

const ADMIN_AUTH_FRONTEND_BASE = normalizeBase(
  process.env.ADMIN_APP_BASE ||
    process.env.ADMIN_AUTH_FRONTEND_BASE ||
    process.env.ADMIN_FRONTEND_BASE,
  'https://admin.alphasourceai.com'
);

function buildClientDashboardUrl(params) {
  return withParams(`${CLIENT_AUTH_FRONTEND_BASE}/dashboard`, params);
}

function buildAdminDashboardUrl(params) {
  return withParams(`${ADMIN_AUTH_FRONTEND_BASE}/admin`, params);
}

function buildClientPwResetUrl(params) {
  return withParams(`${CLIENT_AUTH_FRONTEND_BASE}/pwreset`, params);
}

module.exports = {
  CLIENT_AUTH_FRONTEND_BASE,
  ADMIN_AUTH_FRONTEND_BASE,
  buildClientDashboardUrl,
  buildAdminDashboardUrl,
  buildClientPwResetUrl,
};
