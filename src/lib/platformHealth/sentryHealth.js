'use strict';

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envEnabled,
  envValue,
  fetchJson,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
} = require('./normalizePlatformHealth');

function sentryProjects(env) {
  const projects = [
    envValue(env, ['SENTRY_PROJECT_BACKEND']),
    envValue(env, ['SENTRY_PROJECT_FRONTEND']),
    envValue(env, ['SENTRY_PROJECT']),
  ].filter(Boolean);
  const unique = [];
  for (const project of projects) {
    if (!unique.includes(project)) unique.push(project);
  }
  return unique.slice(0, 4);
}

function sentryPeriod(dateRange) {
  const from = dateRange?.from instanceof Date ? dateRange.from.getTime() : new Date(dateRange?.date_from || 0).getTime();
  const to = dateRange?.to instanceof Date ? dateRange.to.getTime() : new Date(dateRange?.date_to || Date.now()).getTime();
  const days = Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)));
  return `${Math.min(days, 90)}d`;
}

async function fetchSentryIssues(context) {
  const org = envValue(context.env, ['SENTRY_ORG']);
  const headers = {
    Authorization: `Bearer ${envValue(context.env, ['SENTRY_AUTH_TOKEN'])}`,
    'Content-Type': 'application/json',
  };
  const period = sentryPeriod(context.dateRange);
  const projects = sentryProjects(context.env);
  const rows = [];
  for (const project of projects) {
    const url = new URL(`https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/`);
    url.searchParams.set('query', 'is:unresolved');
    url.searchParams.set('statsPeriod', period);
    url.searchParams.set('limit', '25');
    const data = await fetchJson(context, url.toString(), { headers });
    const issues = Array.isArray(data) ? data : [];
    rows.push({
      project,
      unresolved: issues.length,
      newIssues: issues.filter((issue) => trimText(issue?.firstSeen)).length,
      latest: issues[0]?.lastSeen || issues[0]?.firstSeen || null,
    });
  }
  return rows;
}

async function buildSentryHealth(context) {
  const { env, now } = context;
  const captureConfigured = envEnabled(env, 'SENTRY_ENABLED') && envConfigured(env, ['SENTRY_DSN']);
  const apiConfigured = envConfigured(env, ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG']) && sentryProjects(env).length > 0;
  let live = [];
  let liveError = null;

  if (apiConfigured && shouldRunLiveCheck(context, 'SENTRY_METRICS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `sentry:${envValue(env, ['SENTRY_ORG'])}:${sentryProjects(env).join(',')}:${sentryPeriod(context.dateRange)}`,
        () => fetchSentryIssues(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = live.length > 0;
  const unresolved = live.reduce((sum, row) => sum + Number(row.unresolved || 0), 0);
  const newIssues = live.reduce((sum, row) => sum + Number(row.newIssues || 0), 0);
  const warning = Boolean(liveError || unresolved > 0 || (apiConfigured && !liveConnected) || (captureConfigured && !apiConfigured));

  return {
    key: 'sentry',
    name: 'Sentry',
    status: statusWithProblems({ configured: captureConfigured || apiConfigured, liveConnected, warning, problem: unresolved >= 10 }),
    configured: captureConfigured || apiConfigured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : apiConfigured ? 'Live API not connected' : captureConfigured ? 'Connected, usage unavailable' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API' : captureConfigured ? 'Configuration check' : 'Not connected yet',
    source_code: liveConnected ? 'live_vendor_api' : captureConfigured ? 'configuration_check' : 'not_connected',
    meaning: 'Shows captured frontend/backend errors and open issues.',
    health_summary: liveConnected
      ? 'Using Sentry API for unresolved issue counts.'
      : captureConfigured
        ? 'Sentry capture is configured; live issue counts are not connected.'
        : 'Sentry is not configured for this environment.',
    usage_summary: [
      metric('Capture configured', captureConfigured ? 'Yes' : 'No', 'Whether the app is configured to send errors to Sentry.'),
      metric('Projects configured', sentryProjects(env).length, 'Sentry project slugs configured for live issue checks.'),
      metric('Projects checked', live.length, 'Projects successfully read through the Sentry API.'),
    ],
    problem_summary: [
      metric('Open unresolved issues', liveConnected ? unresolved : 'Not available', 'Unresolved issue count returned by Sentry.'),
      metric('New issues in range', liveConnected ? newIssues : 'Not available', 'Issues returned by Sentry for the selected time window.'),
      metric('Most recent issue', live.find((row) => row.latest)?.latest || 'Not available', 'Latest issue timestamp returned by Sentry.'),
    ],
    cost_summary: costSummary({ help: 'Sentry cost and event quota usage are not available through the current issue-count check.' }),
    readiness_items: [
      readiness('Capture setup', captureConfigured ? 'Configured' : 'Missing', 'Required before alphaScreen can send errors to Sentry.'),
      readiness('Issue API', liveConnected ? 'Connected' : 'Not connected', 'Requires Sentry organization, project, and API access.'),
      readiness('Projects', sentryProjects(env).length ? 'Configured' : 'Missing', 'Backend/frontend project slugs used for issue counts.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Sentry live issue check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['Sentry issue counts could not be read; capture configuration is still shown.'] : [],
  };
}

module.exports = { buildSentryHealth };
