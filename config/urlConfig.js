'use strict';

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
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

function resolvePublicBackendBase(fallbackBase) {
  return firstBase(canonical.PUBLIC_BACKEND_URL, fallbackBase);
}

module.exports = {
  canonical,
  trimTrailingSlash,
  firstBase,
  resolvePublicBackendBase,
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
