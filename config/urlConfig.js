'use strict';

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function toOrigin(value) {
  const raw = trimTrailingSlash(value);
  if (!raw) return '';
  try {
    return trimTrailingSlash(new URL(raw).origin);
  } catch (_) {
    return raw;
  }
}

function toHost(value) {
  const raw = trimTrailingSlash(value);
  if (!raw) return '';
  try {
    return String(new URL(raw).hostname || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstBase(...values) {
  for (const value of values) {
    const normalized = trimTrailingSlash(value);
    if (normalized) return normalized;
  }
  return '';
}

const canonical = {
  PUBLIC_SITE_BASE: trimTrailingSlash(process.env.PUBLIC_SITE_BASE),
  CLIENT_APP_BASE: trimTrailingSlash(process.env.CLIENT_APP_BASE),
  ADMIN_APP_BASE: trimTrailingSlash(process.env.ADMIN_APP_BASE),
  INTERVIEW_APP_BASE: trimTrailingSlash(process.env.INTERVIEW_APP_BASE),
  PUBLIC_BACKEND_URL: trimTrailingSlash(process.env.PUBLIC_BACKEND_URL)
};

const frontendUrl = firstBase(
  process.env.FRONTEND_URL,
  'http://localhost:5173'
);

const frontendBase = firstBase(
  process.env.FRONTEND_BASE,
  process.env.FRONTEND_URL,
  frontendUrl
);

const publicSiteBase = firstBase(
  canonical.PUBLIC_SITE_BASE,
  process.env.ACCOUNT_REDIRECT_BASE,
  'https://www.alphasourceai.com'
);

const publicSiteOrFrontendBase = firstBase(
  canonical.PUBLIC_SITE_BASE,
  process.env.ACCOUNT_REDIRECT_BASE,
  process.env.FRONTEND_BASE,
  process.env.FRONTEND_URL,
  'https://www.alphasourceai.com'
);

const clientAppBase = firstBase(
  canonical.CLIENT_APP_BASE,
  process.env.CLIENT_AUTH_FRONTEND_BASE,
  'https://clients.alphasourceai.com'
);

const clientAppBaseWithFrontendFallback = firstBase(
  canonical.CLIENT_APP_BASE,
  process.env.CLIENT_AUTH_FRONTEND_BASE,
  process.env.FRONTEND_BASE,
  process.env.FRONTEND_URL,
  'https://clients.alphasourceai.com'
);

const adminAppBase = firstBase(
  canonical.ADMIN_APP_BASE,
  publicSiteBase
);

const interviewAppBase = firstBase(
  canonical.INTERVIEW_APP_BASE,
  process.env.FRONTEND_BASE,
  process.env.FRONTEND_URL,
  frontendBase
);

const corsDefaultOrigins = Array.from(new Set([
  'http://localhost:5173',
  'https://interview-agent-frontend.onrender.com',
  'https://ia-frontend-prod.onrender.com',
  'https://www.alphasourceai.com',
  'https://alphasourceai.com',
  'https://www-alphasourceai-com.filesusr.com',
  'https://editor.wix.com',
  'https://ia-frontend-qa.onrender.com',
  'https://ia-frontend-staging.onrender.com',
  ...splitCsv(process.env.CORS_DEFAULT_ORIGINS),
  frontendUrl,
  frontendBase,
  publicSiteBase,
  clientAppBase,
  adminAppBase,
  interviewAppBase
].map(toOrigin).filter(Boolean)));

const interviewPrettyLinkHost = toHost(firstBase(
  canonical.INTERVIEW_APP_BASE,
  'https://interviews.alphasourceai.com'
));

function resolvePublicBackendBase(fallbackBase) {
  return firstBase(canonical.PUBLIC_BACKEND_URL, fallbackBase);
}

function isInterviewPrettyLinkHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().split(':')[0];
  return !!host && host === interviewPrettyLinkHost;
}

function serializeQuery(query) {
  if (!query) return '';
  if (query instanceof URLSearchParams) {
    return query.toString();
  }
  if (typeof query === 'string') {
    return query.replace(/^\?+/, '');
  }
  try {
    return new URLSearchParams(query).toString();
  } catch (_) {
    return '';
  }
}

function appendQuery(baseUrl, query) {
  const serialized = serializeQuery(query);
  return serialized ? `${baseUrl}?${serialized}` : baseUrl;
}

function buildPublicAccountUrl(query) {
  return appendQuery(`${publicSiteBase}/account`, query);
}

function buildAdminDashboardUrl(query) {
  return appendQuery(`${adminAppBase}/admin-dashboard`, query);
}

function buildClientPwResetUrl(query) {
  return appendQuery(`${clientAppBase}/pwreset`, query);
}

function buildPublicPwResetUrl(query) {
  return appendQuery(`${publicSiteOrFrontendBase}/pwreset`, query);
}

function buildAcceptInviteUrl(token) {
  return appendQuery(`${frontendUrl}/accept-invite`, { token: String(token || '') });
}

module.exports = {
  canonical,
  trimTrailingSlash,
  toOrigin,
  toHost,
  splitCsv,
  firstBase,
  resolvePublicBackendBase,
  isInterviewPrettyLinkHost,
  buildPublicAccountUrl,
  buildAdminDashboardUrl,
  buildClientPwResetUrl,
  buildPublicPwResetUrl,
  buildAcceptInviteUrl,
  corsDefaultOrigins,
  frontendUrl,
  frontendBase,
  publicSiteBase,
  publicSiteOrFrontendBase,
  clientAppBase,
  clientAppBaseWithFrontendFallback,
  adminAppBase,
  interviewAppBase,
  publicBackendUrl: canonical.PUBLIC_BACKEND_URL
};
