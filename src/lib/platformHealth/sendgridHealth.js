'use strict';

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  fetchJson,
  isoDateOnly,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
} = require('./normalizePlatformHealth');

function addMetric(target, key, value) {
  target[key] = Number(target[key] || 0) + Number(value || 0);
}

function summarizeSendGridStats(data) {
  const totals = {
    requests: 0,
    delivered: 0,
    bounces: 0,
    drops: 0,
    blocks: 0,
    deferred: 0,
    spamReports: 0,
    opens: 0,
    clicks: 0,
  };
  for (const day of Array.isArray(data) ? data : []) {
    for (const stat of Array.isArray(day?.stats) ? day.stats : []) {
      const metrics = stat?.metrics || {};
      addMetric(totals, 'requests', metrics.requests);
      addMetric(totals, 'delivered', metrics.delivered);
      addMetric(totals, 'bounces', metrics.bounces || metrics.bounce_drops);
      addMetric(totals, 'drops', metrics.drops);
      addMetric(totals, 'blocks', metrics.blocks);
      addMetric(totals, 'deferred', metrics.deferred);
      addMetric(totals, 'spamReports', metrics.spam_reports);
      addMetric(totals, 'opens', metrics.opens || metrics.unique_opens);
      addMetric(totals, 'clicks', metrics.clicks || metrics.unique_clicks);
    }
  }
  return totals;
}

async function fetchSendGridStats(context) {
  const url = new URL('https://api.sendgrid.com/v3/stats');
  url.searchParams.set('start_date', isoDateOnly(context.dateRange.from));
  url.searchParams.set('end_date', isoDateOnly(context.dateRange.to));
  url.searchParams.set('aggregated_by', 'day');
  const data = await fetchJson(context, url.toString(), {
    headers: {
      Authorization: `Bearer ${envValue(context.env, ['SENDGRID_API_KEY'])}`,
      'Content-Type': 'application/json',
    },
  });
  return summarizeSendGridStats(data);
}

async function buildSendGridHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['SENDGRID_API_KEY']);
  const webhookConfigured = envConfigured(env, ['SENDGRID_EVENT_WEBHOOK_SECRET', 'SENDGRID_WEBHOOK_PUBLIC_KEY']);
  let live = null;
  let liveError = null;

  if (configured && shouldRunLiveCheck(context, 'SENDGRID_STATS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `sendgrid:${context.dateRange.date_from}:${context.dateRange.date_to}`,
        () => fetchSendGridStats(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live);
  const liveProblems = live ? Number(live.bounces + live.drops + live.blocks + live.deferred + live.spamReports) : 0;
  const problemCount = liveConnected ? liveProblems : signals.emailProblems;
  const problem = problemCount >= 5 && (liveConnected ? problemCount : signals.emailProblemPercent) >= 20;
  const warning = Boolean(liveError || problemCount > 0 || (configured && !liveConnected));

  return {
    key: 'sendgrid',
    name: 'SendGrid',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: liveConnected ? 'Live SendGrid stats API' : 'Live webhook data',
    source_code: liveConnected ? 'live_vendor_api' : 'live_webhook_data',
    meaning: 'Shows transactional email delivery and problem events.',
    health_summary: liveConnected
      ? 'Using SendGrid stats API for selected-period delivery metrics.'
      : configured
        ? 'Using email webhook events stored by alphaScreen.'
        : 'SendGrid credentials are not configured for this environment.',
    usage_summary: liveConnected ? [
      metric('Requests', live.requests, 'SendGrid requests in the selected date range.'),
      metric('Delivered', live.delivered, 'Messages SendGrid reports as delivered.'),
      metric('Opens', live.opens, 'Open events reported by SendGrid stats.'),
      metric('Clicks', live.clicks, 'Click events reported by SendGrid stats.'),
      metric('Last webhook event', signals.lastEmailEventAt || 'Not available', 'Most recent SendGrid webhook event stored by alphaScreen.'),
    ] : [
      metric('Sent/delivered', Number(signals.emailCategoryCounts.sent_delivered || 0), 'Delivery events stored by alphaScreen webhooks.'),
      metric('Engagement', Number(signals.emailCategoryCounts.engagement || 0), 'Open/click/unsubscribe style events stored by alphaScreen.'),
      metric('Events in range', signals.emailEvents.length, 'SendGrid webhook events stored for the selected date range.'),
      metric('Last webhook event', signals.lastEmailEventAt || 'Not available', 'Most recent stored SendGrid event.'),
    ],
    problem_summary: liveConnected ? [
      metric('Bounces', live.bounces, 'Bounces reported by SendGrid stats.'),
      metric('Drops/blocks/deferred', live.drops + live.blocks + live.deferred, 'Delivery problems reported by SendGrid stats.'),
      metric('Spam reports', live.spamReports, 'Spam reports returned by SendGrid stats.'),
    ] : [
      metric('Bounces', signals.bounced, 'Bounce events stored by alphaScreen.'),
      metric('Drops/blocks/deferred', signals.droppedBlockedDeferred, 'Problem events stored by alphaScreen.'),
      metric('Spam reports', signals.spamReports, 'Spam report events stored by alphaScreen.'),
      metric('Problem rate', `${signals.emailProblemPercent}%`, 'Problem events divided by all stored SendGrid events.'),
    ],
    cost_summary: costSummary({ help: 'SendGrid cost is not available through the current stats connection.' }),
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call SendGrid.'),
      readiness('Stats API', liveConnected ? 'Connected' : 'Not connected', 'Used for account-level email stats when available.'),
      readiness('Webhook events', signals.lastEmailEventAt ? 'Receiving events' : 'No recent events', 'Stored events remain available without the stats API.'),
      readiness('Webhook verification', webhookConfigured ? 'Configured' : 'Not configured', 'Shows whether webhook verification configuration is present.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'SendGrid stats check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['SendGrid stats could not be read; stored webhook events are still shown.'] : [],
  };
}

module.exports = { buildSendGridHealth };
