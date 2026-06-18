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
  unixSeconds,
} = require('./normalizePlatformHealth');

function openAIHeaders(env) {
  const headers = {
    Authorization: `Bearer ${envValue(env, ['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY'])}`,
    'Content-Type': 'application/json',
  };
  const orgId = envValue(env, ['OPENAI_ORG_ID', 'OPENAI_ORGANIZATION_ID']);
  const projectId = envValue(env, ['OPENAI_PROJECT_ID']);
  if (orgId) headers['OpenAI-Organization'] = orgId;
  if (projectId) headers['OpenAI-Project'] = projectId;
  return headers;
}

function sumOpenAIUsage(data) {
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: new Set(),
  };
  for (const bucket of Array.isArray(data?.data) ? data.data : []) {
    for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
      totals.requests += Number(result?.num_model_requests || result?.num_requests || 0);
      totals.inputTokens += Number(result?.input_tokens || 0);
      totals.outputTokens += Number(result?.output_tokens || 0);
      if (result?.model) totals.models.add(String(result.model));
    }
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

function sumOpenAICost(data) {
  let value = 0;
  let currency = 'USD';
  for (const bucket of Array.isArray(data?.data) ? data.data : []) {
    for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
      const amount = result?.amount || {};
      const amountValue = Number(amount.value);
      if (Number.isFinite(amountValue)) value += amountValue;
      if (amount.currency) currency = String(amount.currency).toUpperCase();
    }
  }
  return Number.isFinite(value) && value > 0 ? { value: Math.round(value * 100) / 100, currency } : null;
}

async function fetchOpenAIUsage(context) {
  const { env, dateRange } = context;
  const start = unixSeconds(dateRange.from);
  const end = unixSeconds(dateRange.to);
  const headers = openAIHeaders(env);
  const base = 'https://api.openai.com/v1/organization';
  const usageUrl = new URL(`${base}/usage/completions`);
  usageUrl.searchParams.set('start_time', String(start));
  usageUrl.searchParams.set('end_time', String(end));
  usageUrl.searchParams.set('bucket_width', '1d');
  usageUrl.searchParams.set('group_by', 'model');
  usageUrl.searchParams.set('limit', '31');

  const costsUrl = new URL(`${base}/costs`);
  costsUrl.searchParams.set('start_time', String(start));
  costsUrl.searchParams.set('end_time', String(end));
  costsUrl.searchParams.set('bucket_width', '1d');
  costsUrl.searchParams.set('limit', '31');

  const usageData = await fetchJson(context, usageUrl.toString(), { headers });
  let costData = null;
  try {
    costData = await fetchJson(context, costsUrl.toString(), { headers });
  } catch {
    costData = null;
  }
  return {
    usage: sumOpenAIUsage(usageData),
    cost: sumOpenAICost(costData),
  };
}

async function buildOpenAIHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY']);
  const canCheckLive = configured && shouldRunLiveCheck(context, 'OPENAI_USAGE_ENABLED');
  let live = null;
  let liveError = null;

  if (canCheckLive) {
    try {
      live = await cachedLiveCall(
        context,
        `openai:${context.dateRange.date_from}:${context.dateRange.date_to}:${envConfigured(env, ['OPENAI_ADMIN_KEY'])}:${envConfigured(env, ['OPENAI_PROJECT_ID'])}`,
        () => fetchOpenAIUsage(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live?.usage);
  const problem = signals.missingReports >= 5;
  const warning = Boolean(liveError || signals.missingReports > 0 || (configured && !liveConnected));
  const usageSource = liveConnected ? 'Live OpenAI API' : 'alphaScreen report records';
  const usage = liveConnected ? [
    metric('Requests', live.usage.requests, 'Requests reported by the OpenAI organization usage endpoint for the selected date range.'),
    metric('Input tokens', live.usage.inputTokens, 'Text input tokens reported by OpenAI.'),
    metric('Output tokens', live.usage.outputTokens, 'Text output tokens reported by OpenAI.'),
    metric('Total tokens', live.usage.totalTokens, 'Input plus output tokens reported by OpenAI.'),
    metric('Models seen', live.usage.models.size, 'Number of model names returned by the OpenAI usage endpoint.'),
  ] : [
    metric('Reports generated', signals.reports.length, 'Reports created in alphaScreen during the selected date range.'),
    metric('Completed interview proxy', signals.completedInterviews.length, 'Completed interviews used as a proxy for possible scoring usage.'),
    metric('Last report event', signals.lastReportAt || 'Not available', 'Most recent report row in the selected date range.'),
  ];

  return {
    key: 'openai',
    name: 'OpenAI',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: usageSource,
    source_code: liveConnected ? 'live_vendor_api' : 'alphascreen_records',
    meaning: 'Shows AI scoring and report-generation usage.',
    health_summary: liveConnected
      ? 'Live OpenAI usage is connected.'
      : configured
        ? 'Using alphaScreen report records because live OpenAI usage is not connected.'
        : 'OpenAI credentials are not configured for this environment.',
    usage_summary: usage,
    problem_summary: [
      metric('Missing reports after completed interviews', signals.missingReports, 'Completed interviews without a report after the expected processing window.'),
      metric('Live API check', liveError ? 'Failed' : liveConnected ? 'Connected' : 'Not connected', 'Whether alphaScreen could read OpenAI organization usage for this date range.'),
    ],
    cost_summary: live?.cost
      ? costSummary({ value: live.cost.value, currency: live.cost.currency, sourceLabel: 'Live vendor API', help: 'Cost reported by the OpenAI organization costs endpoint.' })
      : costSummary({ help: 'OpenAI live cost data is unavailable unless organization cost access is enabled.' }),
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call OpenAI.'),
      readiness('Live usage API', liveConnected ? 'Connected' : 'Not connected', 'Requires OpenAI organization usage access.'),
      readiness('Record fallback', 'Available', 'alphaScreen report rows remain available when live usage is not connected.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'OpenAI live usage check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['OpenAI live usage could not be read; alphaScreen records are still shown.'] : [],
  };
}

module.exports = { buildOpenAIHealth };
