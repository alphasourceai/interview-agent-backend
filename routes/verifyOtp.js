// routes/verifyOtp.js
const express = require("express");
const { supabase, supabaseAdmin } = require("../src/lib/supabaseClient");
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');

const router = express.Router();
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const VERIFY_OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_OTP_RATE_MAX = 20;

async function verifyOtpRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'verify_otp',
      subjectKey: getRequestSubjectKey(req),
      windowMs: VERIFY_OTP_RATE_WINDOW_MS,
      maxCount: VERIFY_OTP_RATE_MAX
    });
    if (!result.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Too many requests. Please try again later.'
      });
    }
  } catch (error) {
    console.error('[rate-limit] verify otp check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return res.status(503).json({
      error: 'rate_limit_unavailable',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail: 'Request protection is temporarily unavailable. Please try again shortly.'
    });
  }
  return next();
}

/**
 * POST /api/candidate/verify-otp
 * Body (preferred): { email, code, candidate_id?, role_id? }
 * - email and 6-digit code are required
 * - candidate_id/role_id remove ambiguity if the same email is used across roles
 */
router.post("/", verifyOtpRateLimit, async (req, res) => {
  try {
    const request_id = req.request_id || null;
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

    if (roleIdIn && String(cand.role_id || "") !== roleIdIn) {
      return verificationFailed('candidate_role_mismatch', {
        candidate_id: cand.id || null,
        role_id: roleIdIn || null
      });
    }

    const roleId = String(cand.role_id || "");

    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id,client_id')
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
      .select("id, code, expires_at, used, role_id")
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

    // 3) Validate
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return verificationFailed('otp_expired', {
        candidate_id: cand.id || null,
        role_id: roleId
      });
    }
    const isUsed = String(token.used).toLowerCase() === "true"; // supports text/boolean
    if (isUsed) {
      return verificationFailed('otp_already_used', {
        candidate_id: cand.id || null,
        role_id: roleId
      });
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

    return res.status(200).json({
      message: "Verified",
      verified: true,
      candidate_id: cand.id,
      role_id: roleId,
      email
    });
  } catch (e) {
    console.error("verify-otp error", {
      request_id: req.request_id || null,
      message: e?.message || "Server error",
      code: e?.code || null,
      status: e?.response?.status || null
    });
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

module.exports = router;
