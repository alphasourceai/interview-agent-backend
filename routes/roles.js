// routes/roles.js
// Direct-export Express router (standardized)

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');
const { getRoleInterviewAvailability } = require('../src/lib/roleInterviewAvailability');

const { requireAuth, withClientScope } = require('../src/middleware/auth');

// SendGrid setup for rubric change notification
const sg = require('@sendgrid/mail');

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const RUBRIC_CHANGE_TO = process.env.RUBRIC_CHANGE_TO || 'info@alphasourceai.com';
const RUBRIC_CHANGE_FROM = process.env.RUBRIC_CHANGE_FROM || process.env.SENDGRID_FROM_EMAIL || 'info@alphasourceai.com';

if (SENDGRID_KEY) {
  try { sg.setApiKey(SENDGRID_KEY); } catch (e) { console.error('[rubric-change] sendgrid init failed', e?.message || e); }
} else {
  console.warn('[rubric-change] SENDGRID_API_KEY not set; rubric change emails will be skipped');
}

const db = supabaseAdmin || supabase;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const router = express.Router();


/**
 * GET /roles?client_id=...
 * Returns roles for the specified (or scoped) client.
 */
router.get('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      req.query.client_id ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data, error } = await db
      .from('roles')
      .select('id,client_id,title,interview_type,created_at,rubric,job_description_url,slug_or_token')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[GET /roles] supabase error', error);
      return res.status(500).json({ error: 'query failed (roles)' });
    }

    const roles = data || [];
    const parseWholeNonNegative = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    };

    let maxInterviewMinutes = null;
    const { data: planSettings, error: planSettingsError } = await db
      .from('client_plan_settings')
      .select('max_interview_minutes')
      .eq('client_id', clientId)
      .maybeSingle();
    if (planSettingsError) {
      console.warn('[GET /roles] plan settings lookup failed', planSettingsError?.message || planSettingsError);
    } else if (planSettings) {
      maxInterviewMinutes = parseWholeNonNegative(planSettings.max_interview_minutes);
    }

    const availabilityByRoleId = {};
    if (roles.length) {
      const availabilityRows = await Promise.all(roles.map(async (role) => {
        if (!role?.id) {
          return [null, null];
        }
        const availability = await getRoleInterviewAvailability({ db, roleId: role.id, clientId });
        return [role.id, availability];
      }));
      for (const [roleId, availability] of availabilityRows) {
        if (!roleId) continue;
        availabilityByRoleId[roleId] = availability || null;
      }
    }

    const items = roles.map((role) => {
      const availability = availabilityByRoleId[role.id] || null;
      return {
        ...role,
        included_interviews_per_role: availability?.included_interviews_per_role ?? null,
        purchased_interviews: availability?.purchased_interviews ?? null,
        used_interviews: availability?.used_interviews ?? null,
        remaining_interviews: availability?.remaining_interviews ?? null,
        max_interview_minutes: maxInterviewMinutes
      };
    });

    return res.json({ items });
  } catch (e) {
    console.error('[GET /roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /roles
 * Body: { title, description, interview_type, client_id? }
 * Creates a role for the scoped client (or explicit client_id if provided).
 */
router.post('/', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.body.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;

    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const payload = {
      client_id: clientId,
      title: req.body.title || 'Untitled Role',
      description: req.body.description || null,
      interview_type: req.body.interview_type || 'BASIC',
    };

    const { data, error } = await db
      .from('roles')
      .insert(payload)
      .select()
      .limit(1)
      .single();

    if (error) {
      console.error('[POST /roles] supabase error', error);
      return res.status(500).json({ error: 'Failed to create role' });
    }

    return res.json({ role: data });
  } catch (e) {
    console.error('[POST /roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /roles/:id/jd-signed-url
 * Returns signed URL for job description file
 */
router.get('/:id/jd-signed-url', requireAuth, withClientScope, async (req, res) => {
  try {
    const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
    const roleId = req.params.id;
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
    const bucket = process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET || process.env.SUPABASE_JD_BUCKET || 'job-descriptions';

    if (!roleId) {
      return res.status(404).json({ error: 'Not found' });
    }

    let data = null;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !req.userToken) {
      if (!isGlobalAdmin) {
        return res.status(500).json({
          error: 'server_error',
          code: 'JD_ROLE_FETCH_FAILED',
          detail: 'Missing Supabase anon config for user-scoped role lookup',
          hint: null,
          request_id
        });
      }
    } else {
      const userScopedSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${req.userToken}`,
            'X-Client-Info': 'interview-agent-server'
          }
        }
      });

      const { data: roleData, error } = await userScopedSupabase
        .from('roles')
        .select('id,client_id,job_description_url')
        .eq('id', roleId)
        .maybeSingle();

      if (error) {
        console.error('[GET /roles/:id/jd-signed-url] user-scoped role fetch error', error);
        return res.status(500).json({
          error: 'server_error',
          code: 'JD_ROLE_FETCH_FAILED',
          detail: error?.message || 'Failed to fetch role',
          hint: null,
          request_id
        });
      }

      data = roleData || null;
    }

    if (!data && isGlobalAdmin) {
      const { data: adminRole, error } = await supabaseAdmin
        .from('roles')
        .select('id,client_id,job_description_url')
        .eq('id', roleId)
        .maybeSingle();

      if (error) {
        console.error('[GET /roles/:id/jd-signed-url] admin role fetch error', error);
        return res.status(500).json({
          error: 'server_error',
          code: 'JD_ROLE_FETCH_FAILED',
          detail: error?.message || 'Failed to fetch role',
          hint: null,
          request_id
        });
      }

      data = adminRole || null;
    }

    if (!data) {
      return res.status(404).json({ error: 'Not found' });
    }

    const allowedClientIds = new Set();
    const memberships = Array.isArray(req.clientScope?.memberships) ? req.clientScope.memberships : [];
    for (const m of memberships) {
      if (m?.client_id != null) allowedClientIds.add(String(m.client_id));
    }
    if (Array.isArray(req.clientIds)) {
      for (const id of req.clientIds) {
        if (id != null) allowedClientIds.add(String(id));
      }
    }
    const roleClientId = data.client_id == null ? '' : String(data.client_id);
    if (!isGlobalAdmin && (!roleClientId || !allowedClientIds.has(roleClientId))) {
      return res.status(403).json({ error: 'forbidden', code: 'CLIENT_SCOPE_MISMATCH' });
    }

    const rawKey = String(data.job_description_url || '').trim();

    if (!rawKey) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (/^https?:\/\//i.test(rawKey)) {
      return res.json({ url: rawKey });
    }

    let storageKey = rawKey.replace(/^\/+/, '');

    const bucketPrefix = `${bucket}/`;
    if (storageKey.startsWith(bucketPrefix)) {
      storageKey = storageKey.slice(bucketPrefix.length);
    }

    if (!storageKey) {
      return res.status(404).json({ error: 'Not found' });
    }

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(bucket)
      .createSignedUrl(storageKey, 600);

    if (!signErr && signed?.signedUrl) {
      return res.json({ url: signed.signedUrl });
    }

    const msg = String(signErr?.message || '').toLowerCase();
    const notFound =
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('no such') ||
      msg.includes('404') ||
      msg.includes('object');

    if (!notFound) {
      console.error('[GET /roles/:id/jd-signed-url] storage error', {
        request_id,
        bucket,
        storageKey,
        detail: signErr?.message || signErr
      });

      return res.status(500).json({
        error: 'server_error',
        code: 'JD_SIGN_FAILED',
        detail: signErr?.message || 'Failed to sign url',
        hint: null,
        request_id
      });
    }

    const prefix = `${roleClientId}/${data.id}/`;
    const { data: listed, error: listErr } = await supabaseAdmin
      .storage
      .from(bucket)
      .list(prefix, { limit: 100 });

    if (listErr) {
      console.error('[GET /roles/:id/jd-signed-url] storage list error', {
        request_id,
        bucket,
        prefix,
        detail: listErr?.message || listErr
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'JD_SIGN_FAILED',
        detail: listErr?.message || 'Failed to sign url',
        hint: null,
        request_id
      });
    }

    const files = (listed || []).filter((item) => item && item.name && !item.name.endsWith('/'));
    if (!files.length) {
      return res.status(404).json({ error: 'Not found' });
    }
    files.sort((a, b) => {
      const at = Date.parse(a.updated_at || a.created_at || 0) || 0;
      const bt = Date.parse(b.updated_at || b.created_at || 0) || 0;
      if (at !== bt) return bt - at;
      return String(b.name || '').localeCompare(String(a.name || ''));
    });
    const selected = files[0];
    const fallbackKey = `${prefix}${selected.name}`;

    const { data: fallbackSigned, error: fallbackErr } = await supabaseAdmin
      .storage
      .from(bucket)
      .createSignedUrl(fallbackKey, 600);

    if (!fallbackErr && fallbackSigned?.signedUrl) {
      return res.json({ url: fallbackSigned.signedUrl });
    }

    const fallbackMsg = String(fallbackErr?.message || '').toLowerCase();
    const fallbackNotFound =
      fallbackMsg.includes('not found') ||
      fallbackMsg.includes('does not exist') ||
      fallbackMsg.includes('no such') ||
      fallbackMsg.includes('404') ||
      fallbackMsg.includes('object');

    if (fallbackNotFound) {
      return res.status(404).json({ error: 'Not found' });
    }

    console.error('[GET /roles/:id/jd-signed-url] storage error', {
      request_id,
      bucket,
      storageKey: fallbackKey,
      detail: fallbackErr?.message || fallbackErr
    });

    return res.status(500).json({
      error: 'server_error',
      code: 'JD_SIGN_FAILED',
      detail: fallbackErr?.message || 'Failed to sign url',
      hint: null,
      request_id
    });
  } catch (e) {
    console.error('[GET /roles/:id/jd-signed-url] unexpected', e);
    const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
    return res.status(500).json({
      error: 'server_error',
      code: 'JD_SIGN_FAILED',
      detail: e?.message || 'Server error',
      hint: null,
      request_id
    });
  }
});

/**
 * POST /roles/:id/rubric-request-changes
 * Logs a request for rubric changes
 */
router.post('/:id/rubric-request-changes', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId =
      req.body.client_id ||
      req.query.client_id ||
      req.client?.id ||
      req.clientScope?.defaultClientId ||
      null;
    const roleId = req.params.id;

    if (!clientId || !roleId) {
      return res.status(400).json({ error: 'client_id and id required' });
    }

    const { data: roleData, error: roleError } = await db
      .from('roles')
      .select('id,title,client_id')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (roleError) {
      console.error('[POST /roles/:id/rubric-request-changes] supabase error', roleError);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!roleData) {
      return res.status(404).json({ error: 'Not found' });
    }

    console.log('[POST /roles/:id/rubric-request-changes]', {
      clientId,
      roleId,
      notes: (req.body?.notes || '').slice(0, 500),
      questions_count: Array.isArray(req.body?.questions) ? req.body.questions.length : 0,
    });

    // Persist rubric change request (audit trail)
    let changeRequestId = null;
    try {
      const requestId = req.request_id || req.requestId || req.headers['x-request-id'] || null;
      const requestedByUserId = req.user?.id || req.auth?.user_id || null;
      const requestedByEmail = req.user?.email || req.auth?.email || null;
      const requestedByName =
        req.user?.user_metadata?.full_name ||
        req.user?.user_metadata?.name ||
        req.user?.name ||
        null;

      const auditPayload = {
        client_id: clientId,
        role_id: roleId,
        requested_by_user_id: requestedByUserId,
        requested_by_email: requestedByEmail,
        requested_by_name: requestedByName,
        notes: req.body?.notes || null,
        questions: Array.isArray(req.body?.questions) ? req.body.questions : null,
        status: 'new',
        metadata: requestId ? { request_id: requestId } : null,
      };

      const { data: auditRow, error: auditError } = await db
        .from('rubric_change_requests')
        .insert(auditPayload)
        .select('id')
        .limit(1)
        .single();

      if (auditError) {
        console.error('[POST /roles/:id/rubric-request-changes] audit insert error', {
          code: auditError.code,
          message: auditError.message,
          details: auditError.details,
          hint: auditError.hint,
        });
      } else {
        changeRequestId = auditRow?.id || null;
      }
    } catch (e) {
      console.error('[POST /roles/:id/rubric-request-changes] audit insert unexpected', e);
    }

    // Send rubric change notification email
    try {
      if (SENDGRID_KEY) {
        const requestId = req.request_id || req.requestId || req.headers['x-request-id'] || '';
        const userEmail = req.user?.email || req.auth?.email || '';
        const notes = String(req.body?.notes || '').slice(0, 2000);
        const questions = Array.isArray(req.body?.questions) ? req.body.questions.slice(0, 50) : [];

        const subject = `Rubric change request — ${roleData?.title || roleId}`;
        const text =
`Rubric change request received

role_id: ${roleId}
role_title: ${roleData?.title || ''}
client_id: ${clientId}
user_email: ${userEmail}
request_id: ${requestId}

notes:
${notes}

questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`;

        await sg.send({
          to: RUBRIC_CHANGE_TO,
          from: RUBRIC_CHANGE_FROM,
          subject,
          text
        });
      }
    } catch (e) {
      console.error('[POST /roles/:id/rubric-request-changes] email failed', e?.message || e);
    }

    return res.json({ ok: true, change_request_id: changeRequestId || undefined });
  } catch (e) {
    console.error('[POST /roles/:id/rubric-request-changes] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /admin/roles?id=...&client_id=...
 * Also supports JSON body. Requires auth (global admin dashboard behavior).
 */
router.delete('/admin/roles', requireAuth, async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const { data, error } = await db
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /admin/roles] supabase error', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
    if (!data) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[DELETE /admin/roles] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /admin/roles/delete
 * Body: { id, client_id }
 * Mirrors FE fall-back call pattern.
 */
router.post('/admin/roles/delete', requireAuth, async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;

    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'Missing id or client_id' });
    }

    const { data, error } = await db
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[POST /admin/roles/delete] supabase error', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
    if (!data) return res.status(404).json({ error: 'Not found' });

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[POST /admin/roles/delete] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
