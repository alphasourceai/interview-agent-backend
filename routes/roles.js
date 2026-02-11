// routes/roles.js
// Direct-export Express router (standardized)

const express = require('express');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');

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

    return res.json({ items: data || [] });
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

    if (!roleId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const { data, error } = await db
      .from('roles')
      .select('id,client_id,job_description_url')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[GET /roles/:id/jd-signed-url] supabase error', error);
      return res.status(500).json({ error: 'Server error' });
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
    const isGlobalAdmin = req.user?.role === 'admin' || req.user?.is_admin === true;
    const roleClientId = data.client_id == null ? '' : String(data.client_id);
    if (!isGlobalAdmin && (!roleClientId || !allowedClientIds.has(roleClientId))) {
      return res.status(403).json({ error: 'forbidden', code: 'CLIENT_SCOPE_MISMATCH' });
    }

    if (!data.job_description_url) {
      return res.status(404).json({ error: 'Not found' });
    }

    const bucket =
      process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET ||
      process.env.SUPABASE_JD_BUCKET ||
      'job-descriptions';
    const rawUrl = String(data.job_description_url || '').trim();
    if (/^https?:\/\//i.test(rawUrl)) {
      return res.json({ url: rawUrl });
    }

    let strippedPath = rawUrl.replace(/^\/+/, '');
    const bucketPrefixed = `${bucket}/`;
    if (strippedPath.startsWith(bucketPrefixed)) {
      strippedPath = strippedPath.slice(bucketPrefixed.length);
    }
    const bucketIdx = strippedPath.indexOf(bucketPrefixed);
    if (bucketIdx >= 0) {
      strippedPath = strippedPath.slice(bucketIdx + bucketPrefixed.length);
    }
    strippedPath = strippedPath.replace(/^\/+/, '');

    const candidatePaths = [];
    const pushCandidate = (value) => {
      const candidate = String(value || '').trim().replace(/^\/+/, '');
      if (!candidate) return;
      if (!candidatePaths.includes(candidate)) candidatePaths.push(candidate);
    };

    pushCandidate(strippedPath);

    const filename = strippedPath.split(/[?#]/)[0].split('/').filter(Boolean).pop();
    if (filename && roleClientId && data.id) {
      pushCandidate(`${roleClientId}/${data.id}/${filename}`);
      pushCandidate(`${roleClientId}/${filename}`);
      pushCandidate(`${data.id}/${filename}`);
    }

    const storageClient = supabaseAdmin;
    let sawNonNotFound = false;
    for (const attemptedPath of candidatePaths) {
      const { data: urlData, error: storageError } = await storageClient
        .storage
        .from(bucket)
        .createSignedUrl(attemptedPath, 60 * 10);
      if (!storageError && urlData?.signedUrl) {
        return res.json({ url: urlData.signedUrl });
      }
      const msg = String(storageError?.message || '').toLowerCase();
      const notFound =
        msg.includes('not found') ||
        msg.includes('does not exist') ||
        msg.includes('no such') ||
        msg.includes('404') ||
        msg.includes('object');
      if (!notFound) {
        sawNonNotFound = true;
      }
    }

    console.error('[GET /roles/:id/jd-signed-url] storage error', {
      request_id,
      bucket,
      attemptedKeys: candidatePaths
    });

    if (!sawNonNotFound) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(500).json({ error: 'Failed to sign url' });
  } catch (e) {
    console.error('[GET /roles/:id/jd-signed-url] unexpected', e);
    return res.status(500).json({ error: 'Server error' });
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
