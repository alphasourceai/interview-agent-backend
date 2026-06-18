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
  withTimeout,
} = require('./normalizePlatformHealth');

async function runDatabaseHealthCheck(context) {
  const started = Date.now();
  await withTimeout(
    context.db.from('clients').select('id').limit(1),
    Number(context.timeoutMs || 4000)
  );
  return Date.now() - started;
}

async function fetchSupabaseProject(context) {
  const projectRef = envValue(context.env, ['SUPABASE_PROJECT_REF']);
  const accessToken = envValue(context.env, ['SUPABASE_ACCESS_TOKEN']);
  const data = await fetchJson(context, `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return {
    name: data?.name || null,
    region: data?.region || null,
    status: data?.status || data?.database?.status || null,
  };
}

async function buildSupabaseHealth(context) {
  const { env, now, signals, warnings } = context;
  const configured = envConfigured(env, ['SUPABASE_URL']) &&
    envConfigured(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY']);
  const managementConfigured = envConfigured(env, ['SUPABASE_ACCESS_TOKEN']) && envConfigured(env, ['SUPABASE_PROJECT_REF']);
  let responseMs = null;
  let dbError = null;
  let management = null;
  let managementError = null;

  try {
    responseMs = await runDatabaseHealthCheck(context);
  } catch (error) {
    dbError = error;
  }

  if (managementConfigured && shouldRunLiveCheck(context, 'SUPABASE_METRICS_ENABLED')) {
    try {
      management = await cachedLiveCall(
        context,
        `supabase:${envValue(env, ['SUPABASE_PROJECT_REF'])}`,
        () => fetchSupabaseProject(context)
      );
    } catch (error) {
      managementError = error;
    }
  }

  const dbReachable = responseMs !== null && !dbError;
  const liveConnected = Boolean(management);
  const problem = Boolean(dbError);
  const warning = Boolean(managementError || warnings.length);

  return {
    key: 'supabase',
    name: 'Supabase',
    status: statusWithProblems({ configured, liveConnected: dbReachable || liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: dbReachable ? 'Connected' : configured ? 'Check failed' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API and database health check' : 'Configuration check',
    source_code: liveConnected ? 'live_vendor_api' : 'configuration_check',
    meaning: 'Shows database, auth, and storage reachability for the alphaScreen app.',
    health_summary: dbReachable
      ? 'Database health check succeeded.'
      : 'Database health check did not complete.',
    usage_summary: [
      metric('Database response time', responseMs === null ? 'Not available' : `${responseMs} ms`, 'Time for a small read query through the configured Supabase client.'),
      metric('Clients loaded', signals.clients.length, 'Client rows loaded by the metrics endpoint.'),
      metric('Roles loaded', signals.roles.length, 'Role rows loaded by the metrics endpoint.'),
      metric('Candidates in range', signals.candidates.length, 'Candidate rows in the selected date range.'),
      ...(management ? [metric('Project status', management.status || 'Available', 'Status returned by the Supabase Management API.')] : []),
    ],
    problem_summary: [
      metric('Optional source warnings', warnings.length, 'Optional tables or columns unavailable while building the page.'),
      metric('Management usage API', management ? 'Connected' : 'Not connected', 'Requires Supabase Management API configuration.'),
    ],
    cost_summary: costSummary({ help: 'Supabase cost and account usage are unavailable unless Management/Metrics API access is configured.' }),
    readiness_items: [
      readiness('App database client', configured ? 'Configured' : 'Missing', 'Required for alphaScreen database access.'),
      readiness('Database health check', dbReachable ? 'Passed' : 'Failed', dbError ? safeErrorMessage(dbError) : 'Small read query completed.'),
      readiness('Management API', management ? 'Connected' : 'Not connected', 'Used for project-level usage and status when configured.'),
    ],
    troubleshooting_note: dbError ? safeErrorMessage(dbError, 'Supabase health check failed.') : managementError ? safeErrorMessage(managementError, 'Supabase management check failed.') : null,
    last_checked: now.toISOString(),
    notes: managementError ? ['Supabase Management API could not be read; database health is still checked.'] : [],
  };
}

module.exports = { buildSupabaseHealth };
