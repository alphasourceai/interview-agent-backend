'use strict';

const { isScopedGhlSalesUser } = require('./ghlSalesUserScope');
const { isQaStagedSalesLine } = require('./salesQaStaging');

function clean(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

async function jsonRequest(url, options, fetchImpl) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return { ok: response.ok, status: response.status, body };
}

function ghlHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Version: 'v3',
    ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
  };
}

function providerFailure(code, detail, status = 'failed') {
  return { status, errorCode: code, errorDetail: detail };
}

async function finish(db, memberId, provider, result) {
  const response = await db.rpc('finish_sales_provider_sync', {
    p_team_member_id: memberId,
    p_provider: provider,
    p_status: result.status,
    p_provider_reference: result.reference || null,
    p_error_code: result.errorCode || null,
    p_error_detail: result.errorDetail || null,
  });
  if (response.error) throw Object.assign(new Error('Provider sync status update failed'), { cause: response.error });
}

async function verifySlack(record, env, fetchImpl) {
  if (record.config?.notify_slack !== true) return providerFailure('slack_required', 'Slack notifications must remain enabled.', 'action_required');
  if (env.SALES_TEAM_PROVIDER_SYNC_ENABLED !== 'true') return providerFailure('provider_sync_disabled', 'Provider synchronization is disabled.', 'action_required');
  const token = clean(env.SLACK_SALES_WON_BOT_TOKEN, 500);
  const userId = clean(record.member?.slack_user_id, 24);
  if (!token || !userId) return providerFailure('slack_configuration_missing', 'Add a valid Slack member and configure the sales bot token.', 'action_required');
  const result = await jsonRequest(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
  if (!result.ok || result.body?.ok !== true || result.body?.user?.id !== userId || result.body?.user?.deleted === true) {
    return providerFailure('slack_member_verification_failed', 'Slack could not verify an active member with this ID.');
  }
  return { status: 'synced', reference: userId };
}

function ghlConfiguration(record, env) {
  const phone = record.phone || {};
  if (phone.ghl_setup_status !== 'verified' && !isQaStagedSalesLine(record, env)) {
    return { error: providerFailure('ghl_line_setup_unverified', 'Finish and verify the reusable GHL call and notification workflows for this line.', 'action_required') };
  }
  if (env.SALES_TEAM_PROVIDER_SYNC_ENABLED !== 'true') return { error: providerFailure('provider_sync_disabled', 'Provider synchronization is disabled.', 'action_required') };
  const salesLocationId = clean(env.GHL_LOCATION_ID || env.GHL_SALES_LOCATION_ID, 160);
  if (!salesLocationId || clean(phone.ghl_location_id, 160) !== salesLocationId) {
    return { error: providerFailure('ghl_sales_location_mismatch', 'The sales line must use the configured alphaScreen sales location.', 'action_required') };
  }
  const config = {
    token: clean(env.GHL_PRIVATE_INTEGRATION_TOKEN, 1000),
    locationId: clean(phone.ghl_location_id, 160),
    mobileValueId: clean(phone.ghl_mobile_custom_value_id, 160),
    mobileValueName: clean(phone.ghl_mobile_custom_value_name, 120),
    userValueId: clean(phone.ghl_user_custom_value_id, 160),
    userValueName: clean(phone.ghl_user_custom_value_name, 120),
  };
  if (Object.values(config).some((value) => !value)) {
    return { error: providerFailure('ghl_sync_configuration_missing', 'The GHL private integration or managed routing values are not configured.', 'action_required') };
  }
  return { config };
}

function customValueFrom(body) { return body?.customValue || body?.custom_value || body; }
function ghlUserFrom(body) { return body?.user || body; }
function normalizeUsPhone(value) {
  const digits = clean(value, 32).replace(/\D/g, '');
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  return digits.length === 11 && digits.startsWith('1') ? `+${digits}` : clean(value, 32);
}

async function readCustomValue(config, id, fetchImpl) {
  const result = await jsonRequest(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(config.locationId)}/customValues/${encodeURIComponent(id)}`, {
    method: 'GET', headers: ghlHeaders(config.token),
  }, fetchImpl);
  const value = customValueFrom(result.body);
  if (!result.ok || value?.id !== id) throw Object.assign(new Error('GHL custom value lookup failed'), { providerCode: `ghl_custom_value_read_${result.status || 'failed'}` });
  return { id, name: clean(value.name, 120), value: clean(value.value, 500) };
}

async function writeCustomValue(config, item, fetchImpl) {
  const result = await jsonRequest(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(config.locationId)}/customValues/${encodeURIComponent(item.id)}`, {
    method: 'PUT', headers: ghlHeaders(config.token, true), body: JSON.stringify({ name: item.name, value: item.value }),
  }, fetchImpl);
  const value = customValueFrom(result.body);
  if (!result.ok || value?.id !== item.id || value?.name !== item.name || String(value?.value ?? '') !== item.value) {
    throw Object.assign(new Error('GHL custom value update failed'), { providerCode: `ghl_custom_value_write_${result.status || 'failed'}` });
  }
}

async function readGhlUser(config, userId, expectedEmail, fetchImpl) {
  const result = await jsonRequest(`https://services.leadconnectorhq.com/users/${encodeURIComponent(userId)}`, {
    method: 'GET', headers: ghlHeaders(config.token),
  }, fetchImpl);
  const user = ghlUserFrom(result.body);
  const email = clean(user?.email, 254).toLowerCase();
  if (!result.ok || user?.id !== userId || user?.deleted === true || user?.active === false || email !== expectedEmail) {
    throw Object.assign(new Error('GHL user verification failed'), { providerCode: 'ghl_user_verification_failed' });
  }
  if (!isScopedGhlSalesUser(user, config.locationId)) {
    throw Object.assign(new Error('GHL user must be a location-only Account User'), { providerCode: 'ghl_user_access_scope_invalid' });
  }
  return { id: userId, phone: normalizeUsPhone(user?.phone), email };
}

async function restoreGhlRouting(change, env, fetchImpl = global.fetch) {
  const ready = ghlConfiguration(change.record, env);
  if (ready.error) return ready.error;
  const { config } = ready;
  const previous = change.previous || {};
  const writes = [
    () => previous.userValue && writeCustomValue(config, previous.userValue, fetchImpl),
    () => previous.mobileValue && writeCustomValue(config, previous.mobileValue, fetchImpl),
  ];
  let failed = false;
  for (const write of writes) {
    try { await write(); } catch { failed = true; }
  }
  return failed ? providerFailure('ghl_restore_failed', 'GHL did not restore every prior routing value.') : { status: 'synced', reference: config.mobileValueId };
}

async function applyGhlRouting(record, target, env, fetchImpl = global.fetch) {
  const ready = ghlConfiguration(record, env);
  if (ready.error) return ready.error;
  const { config } = ready;
  const mobile = clean(target.mobile, 16);
  const userId = clean(target.ghlUserId, 120);
  const expectedEmail = clean(target.workspaceEmail, 254).toLowerCase();
  if (!/^\+1[2-9]\d{9}$/.test(mobile) || !userId || !expectedEmail) {
    return providerFailure('ghl_recipient_invalid', 'A valid mobile, GHL user, and matching Workspace email are required.', 'action_required');
  }
  const previous = {};
  let writeAttempted = false;
  try {
    previous.user = await readGhlUser(config, userId, expectedEmail, fetchImpl);
    [previous.mobileValue, previous.userValue] = await Promise.all([
      readCustomValue(config, config.mobileValueId, fetchImpl),
      readCustomValue(config, config.userValueId, fetchImpl),
    ]);
    if (previous.mobileValue.name !== config.mobileValueName || previous.userValue.name !== config.userValueName) {
      throw Object.assign(new Error('GHL custom value name mismatch'), { providerCode: 'ghl_custom_value_name_mismatch' });
    }
    writeAttempted = true;
    await writeCustomValue(config, { id: config.mobileValueId, name: previous.mobileValue.name, value: mobile }, fetchImpl);
    await writeCustomValue(config, { id: config.userValueId, name: previous.userValue.name, value: userId }, fetchImpl);
    return { status: 'synced', reference: `${config.mobileValueId}:${config.userValueId}`, previous };
  } catch (error) {
    if (writeAttempted) {
      const restored = await restoreGhlRouting({ record, previous }, env, fetchImpl);
      if (restored.status !== 'synced') return providerFailure('ghl_restore_failed', 'GHL did not confirm the requested routing change or restore every prior value. Review this line before retrying.');
    }
    return providerFailure(error?.providerCode || 'ghl_sync_unavailable', 'GHL did not confirm the SMS recipient and line assignment updates.');
  }
}

async function clearGhlRouting(record, env, fetchImpl = global.fetch) {
  const ready = ghlConfiguration(record, env);
  if (ready.error) return ready.error;
  const { config } = ready;
  const previous = {};
  let writeAttempted = false;
  try {
    [previous.mobileValue, previous.userValue] = await Promise.all([
      readCustomValue(config, config.mobileValueId, fetchImpl),
      readCustomValue(config, config.userValueId, fetchImpl),
    ]);
    if (previous.mobileValue.name !== config.mobileValueName || previous.userValue.name !== config.userValueName) {
      throw Object.assign(new Error('GHL custom value name mismatch'), { providerCode: 'ghl_custom_value_name_mismatch' });
    }
    writeAttempted = true;
    await writeCustomValue(config, { id: config.mobileValueId, name: previous.mobileValue.name, value: '' }, fetchImpl);
    await writeCustomValue(config, { id: config.userValueId, name: previous.userValue.name, value: '' }, fetchImpl);
    return { status: 'synced', reference: `${config.mobileValueId}:${config.userValueId}`, previous };
  } catch (error) {
    if (writeAttempted) {
      const restored = await restoreGhlRouting({ record, previous }, env, fetchImpl);
      if (restored.status !== 'synced') return providerFailure('ghl_restore_failed', 'GHL did not confirm the line clear or restore every prior value. Review this line before retrying.');
    }
    return providerFailure(error?.providerCode || 'ghl_clear_unavailable', 'GHL did not clear both managed line routing values.');
  }
}

async function syncGhl(record, env, fetchImpl) {
  return applyGhlRouting(record, {
    mobile: record.member?.mobile_phone_e164,
    ghlUserId: record.member?.ghl_user_id,
    workspaceEmail: record.member?.workspace_email,
  }, env, fetchImpl);
}

async function verifyXai(record) {
  const phone = record.shared_voice_phone || record.phone || {};
  if (phone.xai_setup_status !== 'verified' || !phone.xai_agent_id || !phone.xai_phone_number_e164 || !phone.handoff_token_rotated_at || !phone.xai_verified_at || !phone.xai_verification_reference) {
    return providerFailure('xai_shared_entrypoint_unverified', 'Finish and verify the shared Grok agent, number, context tool, and message tool.', 'action_required');
  }
  return { status: 'synced', reference: clean(phone.xai_agent_id, 160) };
}

async function checkSalesTeamProviderReadiness({ record, env = process.env, fetchImpl = global.fetch }) {
  const results = {};
  const tasks = [['slack', () => verifySlack(record, env, fetchImpl)], ['xai', () => verifyXai(record)]];
  for (const [provider, run] of tasks) {
    try { results[provider] = await run(); }
    catch { results[provider] = providerFailure(`${provider}_sync_unavailable`, `${provider === 'xai' ? 'Grok Voice' : provider.toUpperCase()} verification is temporarily unavailable.`); }
  }
  return results;
}

async function checkSalesTeamProviders({ record, env = process.env, fetchImpl = global.fetch }) {
  const results = await checkSalesTeamProviderReadiness({ record, env, fetchImpl });
  try { results.ghl = await syncGhl(record, env, fetchImpl); }
  catch { results.ghl = providerFailure('ghl_sync_unavailable', 'GHL verification is temporarily unavailable.'); }
  return results;
}

function providersReady(results) { return Object.values(results || {}).every((result) => result?.status === 'synced'); }

async function recordProviderResults(db, memberId, results) {
  for (const [provider, result] of Object.entries(results)) await finish(db, memberId, provider, result);
}

async function syncSalesTeamProviders({ db, record, env = process.env, fetchImpl = global.fetch }) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  const results = await checkSalesTeamProviders({ record, env, fetchImpl });
  await recordProviderResults(db, record.member.id, results);
  return results;
}

module.exports = {
  applyGhlRouting,
  checkSalesTeamProviderReadiness,
  checkSalesTeamProviders,
  clearGhlRouting,
  providersReady,
  recordProviderResults,
  restoreGhlRouting,
  syncSalesTeamProviders,
  syncGhl,
  verifySlack,
  verifyXai,
};
