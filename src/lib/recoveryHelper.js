'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { supabaseAdmin } = require('./supabaseClient');

const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.FRONTEND_URL || 'https://www.alphasourceai.com').replace(/\/+$/, '');

const redactEmail = (email) => {
  try {
    if (!email) return '';
    const [user, domain] = String(email).split('@');
    if (!domain) return email;
    if (user.length <= 3) return `${user[0] || ''}***@${domain}`;
    return `${user.slice(0, 2)}***@${domain}`;
  } catch (_) {
    return email;
  }
};

async function ensureUserAndSendRecovery({ email, redirectTo, request_id, loggerPrefix = '[recover-helper]' }) {
  const requestId = request_id || crypto.randomUUID?.() || String(Date.now());
  const effectiveRedirect = redirectTo || `${FRONTEND_BASE}/accept-invite`;
  const safeEmail = redactEmail(email);

  console.log(`${loggerPrefix} start`, { request_id: requestId, email: safeEmail, redirect_to: effectiveRedirect, FRONTEND_BASE });

  let userId = null;
  let method = 'existingUser';

  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email });
    if (error) {
      console.error(`${loggerPrefix} listUsers failed`, { request_id: requestId, email: safeEmail, error: error.message, code: error.code });
    }
    const existing = (data?.users || []).find((u) => (u.email || '').toLowerCase() === String(email || '').toLowerCase());
    if (existing) {
      userId = existing.id;
      method = 'existingUser';
    }
  } catch (e) {
    console.error(`${loggerPrefix} listUsers exception`, { request_id: requestId, email: safeEmail, error: e?.message || e });
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
      userId = created?.data?.user?.id || null;
      method = 'createUser';
      console.log(`${loggerPrefix} createUser`, { request_id: requestId, email: safeEmail, userIdPresent: !!userId });
    } catch (e) {
      console.error(`${loggerPrefix} createUser failed`, { request_id: requestId, email: safeEmail, error: e?.message || e, code: e?.code });
      const err = new Error('create_user_failed');
      err.code = 'create_user_failed';
      err.detail = e?.message || e;
      err.request_id = requestId;
      throw err;
    }
  }

  const recoverUrl = `${process.env.SUPABASE_URL}/auth/v1/recover`;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json'
  };
  const payload = { email, redirect_to: effectiveRedirect };

  try {
    const resp = await axios.post(recoverUrl, payload, { headers });
    const ok = resp?.status >= 200 && resp?.status < 300;
    if (!ok) {
      console.error(`${loggerPrefix} recover non-2xx`, {
        request_id: requestId,
        email: safeEmail,
        status: resp?.status || null,
        data: resp?.data || null,
        redirect_to: effectiveRedirect,
        key: 'anon'
      });
      const err = new Error('recover_failed');
      err.code = 'recover_failed';
      err.status = resp?.status || null;
      err.request_id = requestId;
      err.responseData = resp?.data || null;
      throw err;
    }
    console.log(`${loggerPrefix} recovery sent`, {
      request_id: requestId,
      email: safeEmail,
      status: resp?.status || null,
      redirect_to: effectiveRedirect,
      key: 'anon'
    });
    return { userId, method, recovery_sent: true, request_id: requestId };
  } catch (e) {
    const status = e?.response?.status || e?.status || null;
    const data = e?.response?.data || e?.responseData || null;
    console.error(`${loggerPrefix} recover failed`, {
      request_id: requestId,
      email: safeEmail,
      status,
      data,
      redirect_to: effectiveRedirect,
      key: 'anon'
    });
    const err = new Error('recover_failed');
    err.code = 'recover_failed';
    err.status = status;
    err.responseData = data;
    err.request_id = requestId;
    throw err;
  }
}

module.exports = { ensureUserAndSendRecovery, redactEmail };
