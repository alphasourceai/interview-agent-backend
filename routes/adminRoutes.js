import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { sendPasswordResetEmail } from '../utils/sendEmail.js';

const router = express.Router();

// Environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
function _inferEnvBase(env = process.env, fallbackFrontend = FRONTEND_URL) {
  const read = (key) => {
    const value = env?.[key];
    return typeof value === 'string' ? value : '';
  };

  const explicitSrc = `${read('REDIRECT_BASE_URL') || read('AUTH_REDIRECT_BASE')}`.trim();
  if (explicitSrc) return explicitSrc.replace(/\/+$/, '');

  const sentry = read('SENTRY_ENV').toLowerCase();
  if (sentry.includes('qa')) return 'https://ia-frontend-qa.onrender.com';
  if (sentry.includes('stag')) return 'https://ia-frontend-staging.onrender.com';

  const svc = (read('RENDER_SERVICE_NAME') || read('RENDER_EXTERNAL_URL')).toLowerCase();
  const feCandidate = (read('FRONTEND_BASE') || read('FRONTEND_URL') || fallbackFrontend || '').toLowerCase();

  if (feCandidate.includes('qa')) return 'https://ia-frontend-qa.onrender.com';
  if (feCandidate.includes('staging')) return 'https://ia-frontend-staging.onrender.com';
  if (feCandidate.includes('prod') || feCandidate.includes('alphasourceai.com')) return 'https://www.alphasourceai.com';

  if (svc.includes('-qa')) return 'https://ia-frontend-qa.onrender.com';
  if (svc.includes('-staging')) return 'https://ia-frontend-staging.onrender.com';
  if (svc.includes('-prod')) return 'https://www.alphasourceai.com';

  const nodeEnv = (read('NODE_ENV') || process.env.NODE_ENV || '').toLowerCase();
  return nodeEnv === 'production' ? 'https://www.alphasourceai.com' : 'http://localhost:5173';
}
function authRedirect(mode, env) {
  const base = _inferEnvBase(env).replace(/\/+$/, '');
  const qs = (mode === 'recovery') ? 'password_reset=1' : 'auth_callback=1';
  return `${base}/account?${qs}`;
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast on boot if misconfigured
  console.error('[adminRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// Create an admin client specifically for auth-admin calls
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function errPayload({ code = 'internal_error', message = 'Unexpected error', detail = null, hint = null }, status = 500) {
  return { status, body: { error: message, code, detail, hint, request_id: undefined } };
}

const _extractActionLink = (data) =>
  data?.action_link || data?.properties?.action_link || null;

async function generateRecoveryLink(email, redirectTo) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo },
  });

  if (error) {
    const err = new Error(error.message || 'generate_link_failed');
    err.details = error;
    throw err;
  }

  const actionLink = _extractActionLink(data);
  if (!actionLink) {
    const err = new Error('no_action_link');
    err.details = { data };
    throw err;
  }

  return {
    actionLink,
    userId: data?.user?.id || null,
  };
}

async function ensureUserHasRecoveryLink(email, redirectTo) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    return { userId: null, actionLink: null, error: new Error('email_required') };
  }

  let userId = null;
  const createResp = await supabaseAdmin.auth.admin.createUser({
    email: normalized,
    email_confirm: true,
  });

  if (createResp?.data?.user?.id) {
    userId = createResp.data.user.id;
  }

  const createErr = createResp?.error;
  if (createErr) {
    const msg = createErr.message || '';
    if (!/already exists/i.test(msg)) {
      console.error('[ensureUserHasRecoveryLink] createUser failed:', msg);
    }
  }

  try {
    const { actionLink, userId: linkUserId } = await generateRecoveryLink(normalized, redirectTo);
    return { userId: linkUserId || userId, actionLink, error: null };
  } catch (err) {
    console.error('[ensureUserHasRecoveryLink] generateRecoveryLink failed:', err?.message || err);
    return { userId, actionLink: null, error: err };
  }
}

// POST /admin/users/:userId/reset-password
// Body: { email?: string, name?: string }
// If email is not provided, we'll fetch by userId via auth.admin.getUserById
router.post('/users/:userId/reset-password', async (req, res) => {
  const { userId } = req.params;
  const { email: emailFromBody, name: nameFromBody } = req.body || {};

  try {
    let email = emailFromBody;
    let name = nameFromBody || 'User';

    if (!email) {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error) {
        console.error('[reset-password] getUserById error', error);
        const p = errPayload({ code: 'user_lookup_failed', message: 'Unable to locate user by id', detail: error.message });
        return res.status(p.status).json(p.body);
      }
      email = data?.user?.email;
      name = data?.user?.user_metadata?.full_name || name;
      if (!email) {
        const p = errPayload({ code: 'email_missing', message: 'User email not found' }, 400);
        return res.status(p.status).json(p.body);
      }
    }

    let reset_link = null;
    try {
      const { actionLink } = await generateRecoveryLink(email, authRedirect('recovery'));
      reset_link = actionLink;
    } catch (err) {
      console.error('[reset-password] generateRecoveryLink error', err?.message || err);
      const p = errPayload(
        { code: 'link_create_failed', message: 'Could not generate reset link', detail: err?.details?.message || err?.message },
      );
      return res.status(p.status).json(p.body);
    }

    // Send branded email via SendGrid
    await sendPasswordResetEmail({ to: email, name, reset_link });

    return res.json({ ok: true, email, redirect: authRedirect('recovery') });
  } catch (e) {
    console.error('[reset-password] unexpected error', e);
    const p = errPayload({ code: 'unexpected', message: 'Unexpected error', detail: String(e?.message || e) });
    return res.status(p.status).json(p.body);
  }
});

/**
 * POST /admin/client-members
 * Handles creating a new client member and sending a branded invite email via SendGrid.
 */
router.post('/client-members', async (req, res) => {
  try {
    const { client_id, email, name, role = 'member' } = req.body || {};
    if (!client_id || !email || !name) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const redirectTo = authRedirect('recovery');
    const { actionLink, error: ensureErr } = await ensureUserHasRecoveryLink(emailNorm, redirectTo);

    if (!actionLink) {
      const detail = ensureErr?.message || ensureErr?.details?.message || 'no_action_link';
      console.error('[invite] recovery link failed', detail);
      return res.status(500).json({ error: 'generate_link_failed', detail });
    }

    // Send branded invite via SendGrid
    await sendPasswordResetEmail({
      to: emailNorm,
      name,
      reset_link: actionLink,
    });

    console.log(`[invite] Branded invite sent to ${emailNorm}`);

    return res.json({ ok: true, email: emailNorm });
  } catch (e) {
    console.error('[invite] unexpected error', e);
    return res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

/**
 * POST /admin/reset-password
 * Body: { email: string, name?: string }
 * Generates a Supabase recovery link and sends a branded email via SendGrid.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email, name = 'User' } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email_required' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    let reset_link = null;
    try {
      const { actionLink } = await generateRecoveryLink(emailNorm, authRedirect('recovery'));
      reset_link = actionLink;
    } catch (err) {
      console.error('[reset-password] generateRecoveryLink error', err?.message || err);
      return res.status(500).json({ error: 'generate_link_failed', detail: err?.details?.message || err?.message });
    }

    await sendPasswordResetEmail({ to: emailNorm, name, reset_link });
    return res.json({ ok: true, email: emailNorm, redirect: authRedirect('recovery') });
  } catch (e) {
    console.error('[reset-password] unexpected error', e);
    return res.status(500).json({ error: 'server_error', detail: e?.message || String(e) });
  }
});

export const __authRedirect = { authRedirect, _inferEnvBase };
export const __recoveryHelpers = { generateRecoveryLink, ensureUserHasRecoveryLink };

export default router;
