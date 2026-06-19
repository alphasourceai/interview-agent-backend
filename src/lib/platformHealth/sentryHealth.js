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

function parseDateMs(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeIssueText(value, fallback = 'Not available') {
  const raw = trimText(value);
  if (!raw) return fallback;
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]')
    .slice(0, 180);
}

function safeSentryPermalink(value) {
  const raw = trimText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('sentry.io')) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeDateText(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeIssueDetail(issue, project) {
  return {
    project: safeIssueText(project, 'Unknown project'),
    title: safeIssueText(issue?.title || issue?.metadata?.title || issue?.shortId || issue?.id),
    culprit: safeIssueText(issue?.culprit || issue?.metadata?.function || issue?.metadata?.filename || issue?.type),
    level: safeIssueText(issue?.level),
    status: safeIssueText(issue?.status),
    count: Number.isFinite(Number(issue?.count)) ? Number(issue.count) : null,
    user_count: Number.isFinite(Number(issue?.userCount)) ? Number(issue.userCount) : null,
    first_seen: safeDateText(issue?.firstSeen),
    last_seen: safeDateText(issue?.lastSeen),
    permalink: safeSentryPermalink(issue?.permalink),
    platform: safeIssueText(issue?.platform),
    environment: safeIssueText(issue?.environment || issue?.metadata?.environment),
  };
}

async function fetchSentryIssues(context) {
  const org = envValue(context.env, ['SENTRY_ORG']);
  const headers = {
    Authorization: `Bearer ${envValue(context.env, ['SENTRY_AUTH_TOKEN'])}`,
    'Content-Type': 'application/json',
  };
  const period = sentryPeriod(context.dateRange);
  const projects = sentryProjects(context.env);
  const projectRows = [];
  const recentIssues = [];
  const fromMs = context.dateRange?.from instanceof Date
    ? context.dateRange.from.getTime()
    : parseDateMs(context.dateRange?.date_from);
  for (const project of projects) {
    const url = new URL(`https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/`);
    url.searchParams.set('query', 'is:unresolved');
    url.searchParams.set('statsPeriod', period);
    url.searchParams.set('limit', '5');
    const data = await fetchJson(context, url.toString(), { headers });
    const issues = Array.isArray(data) ? data : [];
    projectRows.push({
      project,
      unresolved: issues.length,
      newIssues: issues.filter((issue) => {
        const firstSeenMs = parseDateMs(issue?.firstSeen);
        return firstSeenMs && (!fromMs || firstSeenMs >= fromMs);
      }).length,
      latest: issues[0]?.lastSeen || issues[0]?.firstSeen || null,
    });
    for (const issue of issues) {
      recentIssues.push(safeIssueDetail(issue, project));
    }
  }
  recentIssues.sort((left, right) => parseDateMs(right.last_seen || right.first_seen) - parseDateMs(left.last_seen || left.first_seen));
  return {
    projects: projectRows,
    recentIssues: recentIssues.slice(0, 5),
  };
}

async function buildSentryHealth(context) {
  const { env, now } = context;
  const captureConfigured = envEnabled(env, 'SENTRY_ENABLED') && envConfigured(env, ['SENTRY_DSN']);
  const apiConfigured = envConfigured(env, ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG']) && sentryProjects(env).length > 0;
  let live = null;
  let liveError = null;
  const diagnostics = {
    sentry_capture_configured: captureConfigured,
    sentry_api_status: apiConfigured ? 'not_called' : 'not_configured',
    sentry_project_count: sentryProjects(env).length,
    sentry_projects_checked: 0,
    sentry_recent_issue_count: 0,
  };

  if (apiConfigured && shouldRunLiveCheck(context, 'SENTRY_METRICS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `sentry:${envValue(env, ['SENTRY_ORG'])}:${sentryProjects(env).join(',')}:${sentryPeriod(context.dateRange)}`,
        () => fetchSentryIssues(context)
      );
      diagnostics.sentry_api_status = 'connected';
    } catch (error) {
      liveError = error;
      diagnostics.sentry_api_status = 'failed';
    }
  } else if (apiConfigured) {
    diagnostics.sentry_api_status = 'skipped';
  }

  const projectRows = Array.isArray(live?.projects) ? live.projects : [];
  const recentIssues = Array.isArray(live?.recentIssues) ? live.recentIssues : [];
  const liveConnected = projectRows.length > 0;
  diagnostics.sentry_projects_checked = projectRows.length;
  diagnostics.sentry_recent_issue_count = recentIssues.length;
  const unresolved = projectRows.reduce((sum, row) => sum + Number(row.unresolved || 0), 0);
  const newIssues = projectRows.reduce((sum, row) => sum + Number(row.newIssues || 0), 0);
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
      metric('Projects checked', projectRows.length, 'Projects successfully read through the Sentry API.'),
      metric('Recent issue details', liveConnected ? recentIssues.length : 'Not available', 'Sanitized unresolved issue details included for troubleshooting handoff when API access is connected.'),
    ],
    problem_summary: [
      metric('Open unresolved issues', liveConnected ? unresolved : 'Not available', 'Unresolved issue count returned by Sentry.'),
      metric('New issues in range', liveConnected ? newIssues : 'Not available', 'Issues returned by Sentry for the selected time window.'),
      metric('Most recent issue', projectRows.find((row) => row.latest)?.latest || 'Not available', 'Latest issue timestamp returned by Sentry.'),
    ],
    cost_summary: costSummary({ help: 'Sentry cost and event quota usage are not available through the current issue-count check.' }),
    recent_issues: recentIssues,
    diagnostics,
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
