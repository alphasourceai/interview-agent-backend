// routes/verifyOtp.js
const express = require("express");
const Sentry = require('@sentry/node');
const sg = require('@sendgrid/mail');
const { supabase, supabaseAdmin } = require("../src/lib/supabaseClient");
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../src/lib/roleLifecycle');
const { sendCandidateError } = require('../src/lib/candidateErrors');
const { buildBrandedEmailShell, escapeHtml } = require('../utils/mailer');

const router = express.Router();
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);
const VERIFY_OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_OTP_RATE_MAX = 20;
const RESEND_OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const RESEND_OTP_RATE_MAX = 5;
const RESEND_OTP_MESSAGE = 'If your information is accepted, a new verification code will be sent shortly.';

async function verifyOtpRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'verify_otp',
      subjectKey: getRequestSubjectKey(req),
      windowMs: VERIFY_OTP_RATE_WINDOW_MS,
      maxCount: VERIFY_OTP_RATE_MAX
    });
    if (!result.allowed) {
      return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    }
  } catch (error) {
    console.error('[rate-limit] verify otp check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
  }
  return next();
}

async function resendOtpRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'resend_otp',
      subjectKey: getRequestSubjectKey(req),
      windowMs: RESEND_OTP_RATE_WINDOW_MS,
      maxCount: RESEND_OTP_RATE_MAX
    });
    if (!result.allowed) {
      return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    }
  } catch (error) {
    console.error('[rate-limit] resend otp check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
  }
  return next();
}

function six() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function buildOtpEmailHtml(appName, otpCode) {
  const safeAppName = escapeHtml(appName || 'Interview Agent');
  const safeOtpCode = escapeHtml(otpCode || '');
  return buildBrandedEmailShell({
    title: 'Your verification code',
    preheader: `Your verification code is ${safeOtpCode}. It expires in 10 minutes.`,
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">
        Use this one-time code to continue your ${safeAppName} verification.
      </p>
      <p style="margin:0 0 16px;">
        <span style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">
          ${safeOtpCode}
        </span>
      </p>
      <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
        This code expires in 10 minutes.
      </p>
    `
  });
}

/**
 * POST /api/candidate/verify-otp/resend
 * Body: { email, candidate_id? } or { email, role_id }
 */
router.post("/resend", resendOtpRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  Sentry.setTag('route_name', 'resend_otp');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  const generic = () => res.status(200).json({ message: RESEND_OTP_MESSAGE });
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const candidateIdIn = req.body?.candidate_id ? String(req.body.candidate_id).trim() : "";
    const roleIdIn = req.body?.role_id ? String(req.body.role_id).trim() : "";
    if (!email) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'EMAIL_REQUIRED',
        detail: 'email is required',
        request_id
      });
    }

    let cand = null, cErr = null;
    if (candidateIdIn) {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id, email")
        .eq("id", candidateIdIn)
        .maybeSingle());
      if (!cErr && cand && String(cand.email || "").trim().toLowerCase() !== email) return generic();
    } else {
      if (!roleIdIn) return generic();
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id, email")
        .eq("email", email)
        .eq("role_id", roleIdIn)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle());
    }
    if (cErr || !cand) return generic();

    const candidate_id = cand.id;
    const roleId = String(cand.role_id || roleIdIn || "");
    if (!roleId) return generic();
    Sentry.setTag('candidate_id', String(candidate_id));
    Sentry.setTag('role_id', String(roleId));

    const { data: resendRole, error: resendRoleErr } = await supabase
      .from('roles')
      .select('id,status')
      .eq('id', roleId)
      .maybeSingle();
    if (resendRoleErr || !resendRole) return generic();
    if (isRoleInactive(resendRole)) {
      logInactiveRoleBlocked(console, {
        route_name: 'resend_otp',
        request_id,
        role_id: roleId
      });
      return generic();
    }

    const nowIso = new Date().toISOString();
    const { error: invalidateErr } = await supabase
      .from("otp_tokens")
      .update({ used: true, used_at: nowIso })
      .eq("candidate_email", email)
      .eq("role_id", roleId)
      .eq("used", false);
    if (invalidateErr) {
      console.error('[resend-otp] invalidate failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        error: invalidateErr.message,
        code: invalidateErr.code || null
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'OTP_INVALIDATE_FAILED',
        detail: 'Unable to resend verification code at this time.',
        request_id
      });
    }

    const freshCode = six();
    const { error: otpErr } = await supabase.from("otp_tokens").insert({
      candidate_email: email,
      candidate_id,
      role_id: roleId,
      code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    });
    if (otpErr) {
      console.error('[resend-otp] otp create failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        error: otpErr.message,
        code: otpErr.code || null
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'OTP_CREATE_FAILED',
        detail: 'Unable to resend verification code at this time.',
        request_id
      });
    }

    res.status(200).json({ message: RESEND_OTP_MESSAGE });

    setImmediate(async () => {
      console.log('[resend-otp] background_email_start', {
        request_id,
        candidate_id,
        role_id: roleId,
        email
      });
      try {
        if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
        const [resp] = await sg.send({
          to: email,
          from: { email: FROM_EMAIL, name: APP_NAME },
          subject: `Your ${APP_NAME} verification code`,
          text: `Your verification code is ${freshCode}. It expires in 10 minutes.`,
          html: buildOtpEmailHtml(APP_NAME, freshCode),
        });
        console.log('[resend-otp] background_email_success', {
          request_id,
          candidate_id,
          role_id: roleId,
          email,
          status: resp?.statusCode || null
        });
      } catch (e) {
        const status = e?.response?.status || e?.code || null;
        const message = e?.message || 'send_failed';
        console.warn('[resend-otp] background_email_failed', {
          request_id,
          candidate_id,
          role_id: roleId,
          email,
          status,
          message
        });
        Sentry.captureException(e, {
          tags: {
            route_name: 'resend_otp',
            surface: 'backend',
            task: 'background_resend_otp_email',
            request_id: request_id || undefined,
            candidate_id: candidate_id || undefined,
            role_id: roleId || undefined
          },
          extra: {
            request_id,
            candidate_id,
            role_id: roleId,
            email,
            status,
            message
          }
        });
      }
    });
    return;
  } catch (e) {
    console.error("resend-otp error", {
      request_id,
      message: e?.message || "Server error",
      code: e?.code || null,
      status: e?.response?.status || null
    });
    Sentry.captureException(e, {
      tags: {
        route_name: 'resend_otp',
        surface: 'backend',
        request_id: request_id || undefined
      },
      extra: { request_id }
    });
    return res.status(500).json({
      error: "server_error",
      code: "RESEND_OTP_FAILED",
      detail: "Unable to resend verification code at this time.",
      request_id
    });
  }
});

/**
 * POST /api/candidate/verify-otp
 * Body (preferred): { email, code, candidate_id?, role_id? }
 * - email and 6-digit code are required
 * - candidate_id/role_id remove ambiguity if the same email is used across roles
 */
router.post("/", verifyOtpRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'verify_otp');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const verificationFailed = (reason, details = {}) => {
      console.warn('[verify-otp] verification_failed', {
        request_id,
        reason,
        ...details
      });
      const payload = {
        error: 'verification_failed',
        code: 'VERIFICATION_FAILED',
        detail: 'Verification failed. Please check your code and try again.'
      };
      if (request_id) payload.request_id = request_id;
      return res.status(400).json(payload);
    };
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code  = String(req.body?.code  || "").trim();
    const candidateIdIn = req.body?.candidate_id ? String(req.body.candidate_id).trim() : "";
    const roleIdIn      = req.body?.role_id ? String(req.body.role_id).trim() : "";

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid email or 6-digit code." });
    }

    // 1) Resolve candidate + role
    let cand = null, cErr = null;
    if (candidateIdIn) {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id, email")
        .eq("id", candidateIdIn)
        .single());
      if (!cErr && cand) {
        const candidateEmail = String(cand.email || "").trim().toLowerCase();
        if (candidateEmail !== email) {
          return verificationFailed('candidate_email_mismatch', {
            candidate_id: candidateIdIn || null
          });
        }
      }
    } else if (roleIdIn) {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id")
        .eq("email", email)
        .eq("role_id", roleIdIn)
        .order("created_at", { ascending: false })
        .limit(1)
        .single());
    } else {
      ({ data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id, role_id")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .single());
    }
    if (cErr || !cand) {
      return verificationFailed('candidate_not_found', {
        candidate_id: candidateIdIn || null,
        role_id: roleIdIn || null
      });
    }
    sentryCandidateId = cand.id || null;
    if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    Sentry.addBreadcrumb({
      category: 'verify_otp',
      message: 'candidate loaded',
      level: 'info',
      data: { candidate_id: cand.id || null }
    });

    if (roleIdIn && String(cand.role_id || "") !== roleIdIn) {
      return verificationFailed('candidate_role_mismatch', {
        candidate_id: cand.id || null,
        role_id: roleIdIn || null
      });
    }

    const roleId = String(cand.role_id || "");
    sentryRoleId = roleId || null;
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));

    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id,client_id,status')
      .eq('id', roleId)
      .maybeSingle();
    if (roleErr || !role) {
      return res.status(500).json({
        error: 'server_error',
        code: 'ROLE_LOOKUP_FAILED',
        detail: roleErr?.message || 'Failed to load role record',
        hint: roleErr?.hint || null,
          request_id
        });
    }
    sentryClientId = role.client_id || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'verify_otp',
        request_id,
        role_id: roleId
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }
    Sentry.addBreadcrumb({
      category: 'verify_otp',
      message: 'role loaded',
      level: 'info',
      data: { role_id: roleId, client_id: role.client_id || null }
    });

    if (BILLING_ENFORCED && role.client_id) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact')
        .eq('id', role.client_id)
        .maybeSingle();
      if (clientErr || !client) {
        return res.status(500).json({
          error: 'server_error',
          code: 'CLIENT_LOOKUP_FAILED',
          detail: clientErr?.message || 'Failed to load client record',
          hint: clientErr?.hint || null,
          request_id
        });
      }
      Sentry.addBreadcrumb({
        category: 'verify_otp',
        message: 'client loaded',
        level: 'info',
        data: { client_id: role.client_id || null }
      });
      const accessOverrideMode = String(client.access_override_mode || 'inherit').toLowerCase();
      if (accessOverrideMode === 'force_inactive' || (accessOverrideMode !== 'force_active' && client.billing_status !== 'active')) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'CLIENT_INACTIVE',
          detail: 'Interviewing service is currently inactive for this employer.',
          hint: client.candidate_assistance_contact || 'Please contact the employer.',
          request_id
        });
      }
    }

    const availability = await getRoleInterviewAvailability({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null
    });
    await syncRoleInterviewLimitNotification({
      db: supabaseAdmin,
      roleId,
      clientId: role.client_id || null,
      remainingInterviews: availability.remaining_interviews,
      roleTitle: ''
    });
    if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
      Sentry.addBreadcrumb({
        category: 'verify_otp',
        message: 'interview limit reached',
        level: 'info',
        data: { role_id: roleId, client_id: role.client_id || null }
      });
      return res.status(403).json({
        error: 'forbidden',
        code: 'interview_limit_reached',
        detail: 'This role has no interviews remaining under the current plan.',
        hint: null,
        request_id
      });
    }

    // 2) Newest OTP for (candidate_email, role_id)
    const { data: token, error: tErr } = await supabase
      .from("otp_tokens")
      .select("id, code, expires_at, used, role_id, invalidated_at")
      .eq("candidate_email", email)
      .eq("role_id", roleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tErr || !token) {
      return verificationFailed('otp_not_found', {
        candidate_id: cand.id || null,
        role_id: roleId
      });
    }
    if (token.invalidated_at) {
      return sendCandidateError(res, 'STALE_ACCESS_INVALIDATED', { request_id });
    }
    Sentry.addBreadcrumb({
      category: 'verify_otp',
      message: 'otp token loaded',
      level: 'info',
      data: { otp_token_id: token.id || null, candidate_id: cand.id || null, role_id: roleId }
    });

    // 3) Validate
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      console.warn('[verify-otp] otp_expired', {
        request_id,
        candidate_id: cand.id || null,
        role_id: roleId
      });
      return sendCandidateError(res, 'OTP_EXPIRED', { request_id });
    }
    const isUsed = String(token.used).toLowerCase() === "true"; // supports text/boolean
    if (isUsed) {
      console.warn('[verify-otp] otp_used', {
        request_id,
        candidate_id: cand.id || null,
        role_id: roleId
      });
      return sendCandidateError(res, 'OTP_USED', { request_id });
    }
    if (String(token.code) !== code) {
      return verificationFailed('otp_invalid_code', {
        candidate_id: cand.id || null,
        role_id: roleId
      });
    }

    // 4) Mark OTP used (handle text/boolean schemas). Prefer update by id; confirm with read-back.
    const updatesToTry = [
      { used: true,  used_at: new Date().toISOString() }, // boolean + used_at (newer schema)
      { used: true },                                     // boolean only
      { used: "true" },                                   // text schema
    ];

    let updatedOk = false;
    let lastErr = null;

    for (const payload of updatesToTry) {
      const { error } = await supabase.from("otp_tokens").update(payload).eq("id", token.id);
      if (!error) {
        const { data: checkRow } = await supabase
          .from("otp_tokens")
          .select("used")
          .eq("id", token.id)
          .single();
        const nowUsed = String(checkRow?.used).toLowerCase() === "true";
        if (nowUsed) { updatedOk = true; break; }
      } else {
        lastErr = error;
      }
    }

    // Last-resort composite update if id route failed (RLS quirks, etc.)
    if (!updatedOk) {
      const { error } = await supabase
        .from("otp_tokens")
        .update({ used: "true" }) // text-safe; casts in boolean schemas as well
        .eq("candidate_email", email)
        .eq("role_id", roleId)
        .eq("code", code);
      if (!error) {
        const { data: checkRow2 } = await supabase
          .from("otp_tokens")
          .select("used")
          .eq("candidate_email", email)
          .eq("role_id", roleId)
          .eq("code", code)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        const nowUsed = String(checkRow2?.used).toLowerCase() === "true";
        updatedOk = nowUsed;
      } else {
        lastErr = error;
      }
    }

    if (!updatedOk) {
      console.error("mark-used failed:", lastErr);
      return res.status(500).json({ error: "Could not mark OTP as used." });
    }

    // 5) Update candidate to Verified (set flags + timestamp)
    const { error: uCandErr } = await supabase
      .from("candidates")
      .update({ status: "Verified", verified: true, otp_verified_at: new Date().toISOString() })
      .eq("id", cand.id);
    if (uCandErr) return res.status(500).json({ error: "Could not update verification status." });
    Sentry.addBreadcrumb({
      category: 'verify_otp',
      message: 'otp verified',
      level: 'info',
      data: { candidate_id: cand.id || null, role_id: roleId }
    });

    return res.status(200).json({
      message: "Verified",
      verified: true,
      candidate_id: cand.id,
      role_id: roleId,
      email
    });
  } catch (e) {
    console.error("verify-otp error", {
      request_id,
      message: e?.message || "Server error",
      code: e?.code || null,
      status: e?.response?.status || null
    });
    Sentry.captureException(e, {
      tags: {
        route_name: 'verify_otp',
        surface: 'backend',
        request_id: request_id || undefined,
        candidate_id: sentryCandidateId || undefined,
        role_id: sentryRoleId || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

module.exports = router;
