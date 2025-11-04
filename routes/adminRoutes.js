
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { sendPasswordResetEmail } from '../utils/sendEmail.js';

const router = express.Router();

// Environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESET_REDIRECT_URL = process.env.RESET_REDIRECT_URL || 'https://www.alphasourceai.com/account';

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

    // Generate a password recovery link
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.createLink({
      type: 'recovery',
      email,
      options: { redirectTo: RESET_REDIRECT_URL },
    });

    if (linkError) {
      console.error('[reset-password] createLink error', linkError);
      const p = errPayload({ code: 'link_create_failed', message: 'Could not generate reset link', detail: linkError.message });
      return res.status(p.status).json(p.body);
    }

    const reset_link = linkData?.properties?.action_link || linkData?.action_link;
    if (!reset_link) {
      const p = errPayload({ code: 'link_missing', message: 'Reset link not returned from Supabase' });
      return res.status(p.status).json(p.body);
    }

    // Send branded email via SendGrid
    await sendPasswordResetEmail({ to: email, name, reset_link });

    return res.json({ ok: true, email, redirect: RESET_REDIRECT_URL });
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

    // Generate signup link (no Supabase default email)
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'signup',
      email: emailNorm,
      options: {
        data: { name, role },
        redirectTo: RESET_REDIRECT_URL,
      },
    });

    let inviteLink = linkData?.action_link || linkData?.properties?.action_link;
    if (linkError || !inviteLink) {
      // fallback: if user already exists, try recovery link
      const { data: recData, error: recErr } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: emailNorm,
        options: { redirectTo: RESET_REDIRECT_URL },
      });
      if (recErr) {
        console.error('[invite] recovery link failed', recErr);
        return res.status(400).json({ error: recErr.message || 'generate_recovery_failed' });
      }
      inviteLink = recData?.action_link || recData?.properties?.action_link;
    }

    if (!inviteLink) {
      return res.status(400).json({ error: 'invite_link_missing' });
    }

    // Send branded invite via SendGrid
    await sendPasswordResetEmail({
      to: emailNorm,
      name,
      reset_link: inviteLink,
    });

    console.log(`[invite] Branded invite sent to ${emailNorm}`);

    return res.json({ ok: true, email: emailNorm });
  } catch (e) {
    console.error('[invite] unexpected error', e);
    return res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

export default router;