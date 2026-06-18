'use strict';

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  fetchJson,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
} = require('./normalizePlatformHealth');

function tavusApiBase(env) {
  return (envValue(env, ['TAVUS_API_BASE', 'TAVUS_API_BASE_URL']) || 'https://tavusapi.com/v2').replace(/\/+$/, '');
}

function tavusHeaders(env) {
  const value = envValue(env, ['TAVUS_API_KEY']);
  return {
    'x-api-key': value,
    Authorization: `Bearer ${value}`,
    'Content-Type': 'application/json',
  };
}

async function fetchTavusConversationPage(context) {
  const url = new URL(`${tavusApiBase(context.env)}/conversations`);
  url.searchParams.set('limit', '100');
  const data = await fetchJson(context, url.toString(), { headers: tavusHeaders(context.env) });
  const rows = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.conversations)
      ? data.conversations
      : Array.isArray(data)
        ? data
        : [];
  return {
    returned: rows.length,
    statuses: rows.reduce((counts, row) => {
      const status = trimText(row?.status || row?.conversation_status || row?.state) || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
  };
}

async function buildTavusHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['TAVUS_API_KEY']);
  const webhookConfigured = envConfigured(env, ['TAVUS_WEBHOOK_SECRET']);
  const canCheckLive = configured && shouldRunLiveCheck(context, 'TAVUS_USAGE_ENABLED');
  let live = null;
  let liveError = null;

  if (canCheckLive) {
    try {
      live = await cachedLiveCall(
        context,
        `tavus:${context.dateRange.date_from}:${context.dateRange.date_to}:${tavusApiBase(env)}`,
        () => fetchTavusConversationPage(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live);
  const problem = signals.recordingProblems >= 5;
  const warning = Boolean(liveError || signals.recordingPending || signals.recordingProblems || signals.perceptionMissing || (configured && !liveConnected));
  const sourceLabel = liveConnected ? 'Live vendor API and alphaScreen records' : 'alphaScreen recording and webhook records';

  return {
    key: 'tavus',
    name: 'Tavus',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: sourceLabel,
    source_code: liveConnected ? 'live_vendor_api' : 'alphascreen_records',
    meaning: 'Shows video screening session, recording, transcript, and perception health.',
    health_summary: liveConnected
      ? 'Using Tavus API reachability plus alphaScreen recording and webhook records.'
      : configured
        ? 'Using alphaScreen recording and webhook records because live Tavus usage is not connected.'
        : 'Tavus credentials are not configured for this environment.',
    usage_summary: [
      metric('Interview starts', signals.interviews.length, 'Interview rows created in the selected date range.'),
      metric('Recording ready', signals.recordingReady, 'Recordings marked ready by Tavus webhook processing.'),
      metric('Transcript ready', signals.transcriptReady.length, 'Interviews with transcript data available.'),
      metric('Perception events', signals.perceptionEvents.length, 'Tavus perception webhook events stored by alphaScreen.'),
      metric('Estimated minutes', signals.estimatedMinutes === null ? 'Not available' : signals.estimatedMinutes, 'Estimated from recording metadata when duration is present.'),
      ...(liveConnected ? [metric('Live conversations returned', live.returned, 'Latest conversation page returned by Tavus API.')] : []),
    ],
    problem_summary: [
      metric('Pending/problem recordings', signals.recordingPending + signals.recordingProblems, 'Recordings not ready or marked problem in alphaScreen records.'),
      metric('Deleted recordings', signals.recordingDeleted, 'Recordings marked deleted in alphaScreen records.'),
      metric('Perception missing proxy', signals.perceptionMissing, 'Completed interviews without a matching perception event after the expected window.'),
      metric('Last webhook event', signals.lastTavusWebhookAt || 'Not available', 'Most recent Tavus webhook event stored for this range.'),
    ],
    cost_summary: costSummary({ help: 'Tavus cost is not available unless Tavus exposes account usage or billing data for this environment.' }),
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call Tavus.'),
      readiness('Webhook receiver', signals.lastTavusWebhookAt ? 'Receiving events' : 'No recent events', 'Based on Tavus webhook rows stored by alphaScreen.'),
      readiness('Webhook verification', webhookConfigured ? 'Configured' : 'Not configured', 'Shows whether webhook verification configuration is present.'),
      readiness('Live usage API', liveConnected ? 'Connected' : 'Not connected', 'The adapter checks Tavus API reachability and uses records for selected-period totals.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Tavus live check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['Tavus live API could not be read; alphaScreen recording records are still shown.'] : [],
  };
}

module.exports = { buildTavusHealth };
