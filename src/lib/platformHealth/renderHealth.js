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

function renderServiceIds(env) {
  const ids = [
    envValue(env, ['RENDER_BACKEND_SERVICE_ID', 'RENDER_QA_BACKEND_SERVICE_ID']),
    envValue(env, ['RENDER_FRONTEND_SERVICE_ID', 'RENDER_QA_FRONTEND_SERVICE_ID']),
  ].filter(Boolean);
  const combined = envValue(env, ['RENDER_SERVICE_IDS', 'RENDER_SERVICE_ID']);
  for (const part of combined.split(',')) {
    const id = trimText(part);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 4);
}

async function fetchRenderServices(context) {
  const headers = {
    Authorization: `Bearer ${envValue(context.env, ['RENDER_API_KEY'])}`,
    Accept: 'application/json',
  };
  const services = [];
  for (const id of renderServiceIds(context.env)) {
    const service = await fetchJson(context, `https://api.render.com/v1/services/${encodeURIComponent(id)}`, { headers });
    let deploy = null;
    try {
      const deploys = await fetchJson(context, `https://api.render.com/v1/services/${encodeURIComponent(id)}/deploys?limit=1`, { headers });
      deploy = Array.isArray(deploys) ? deploys[0] : Array.isArray(deploys?.data) ? deploys.data[0] : null;
    } catch {
      deploy = null;
    }
    services.push({
      name: service?.service?.name || service?.name || id,
      type: service?.service?.type || service?.type || 'service',
      suspended: service?.service?.suspended || service?.suspended || null,
      deployStatus: deploy?.deploy?.status || deploy?.status || null,
      deployCreatedAt: deploy?.deploy?.createdAt || deploy?.createdAt || null,
      deployFinishedAt: deploy?.deploy?.finishedAt || deploy?.finishedAt || null,
    });
  }
  return services;
}

async function buildRenderHealth(context) {
  const { env, now } = context;
  const configured = envConfigured(env, ['RENDER_API_KEY']) && renderServiceIds(env).length > 0;
  let live = [];
  let liveError = null;

  if (configured && shouldRunLiveCheck(context, 'RENDER_METRICS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `render:${renderServiceIds(env).join(',')}`,
        () => fetchRenderServices(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = live.length > 0;
  const failedDeploys = live.filter((service) => /fail|cancel|error/i.test(String(service.deployStatus || ''))).length;
  const warning = Boolean(liveError || failedDeploys > 0 || (configured && !liveConnected));

  return {
    key: 'render',
    name: 'Render',
    status: statusWithProblems({ configured, liveConnected, warning, problem: failedDeploys >= 2 }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API' : 'Configuration check',
    source_code: liveConnected ? 'live_vendor_api' : 'configuration_check',
    meaning: 'Shows app/API service deploy and runtime health.',
    health_summary: liveConnected
      ? 'Using Render API service and deploy status.'
      : configured
        ? 'Render API configuration is present, but live status could not be read.'
        : 'Render API is not configured for this environment.',
    usage_summary: [
      metric('Configured services', renderServiceIds(env).length, 'Render service identifiers configured for this environment.'),
      metric('Live services checked', live.length, 'Render services successfully read through the API.'),
      metric('Latest deploy status', live[0]?.deployStatus || 'Not available', 'Most recent deploy status from the first configured service.'),
      metric('Latest deploy time', live[0]?.deployFinishedAt || live[0]?.deployCreatedAt || 'Not available', 'Most recent deploy timestamp returned by Render.'),
    ],
    problem_summary: [
      metric('Failed deploys returned', failedDeploys, 'Configured Render services whose latest deploy returned a failed/canceled/error status.'),
      metric('Live service alerts', liveError ? 'Check failed' : liveConnected ? 'None returned' : 'Not connected', 'This page does not expose raw Render payloads.'),
    ],
    cost_summary: costSummary({ help: 'Render cost and runtime resource metrics are not available through the current service-status check.' }),
    readiness_items: [
      readiness('Credentials', envConfigured(env, ['RENDER_API_KEY']) ? 'Configured' : 'Missing', 'Required before alphaScreen can call Render.'),
      readiness('Service identifiers', renderServiceIds(env).length ? 'Configured' : 'Missing', 'Required to read backend/frontend service health.'),
      readiness('Service API', liveConnected ? 'Connected' : 'Not connected', 'Reads Render service and latest deploy status.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Render live check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['Render API could not be read; current request health still succeeded.'] : [],
  };
}

module.exports = { buildRenderHealth };
