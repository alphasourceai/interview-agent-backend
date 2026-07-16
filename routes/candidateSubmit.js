// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../src/lib/roleLifecycle');
const {
  normalizeCandidatePhoneCountry,
  normalizeCandidatePhone,
  getCandidatePhoneValidationMessage
} = require('../src/lib/candidatePhone');
const { buildCandidateError, sendCandidateError, getInterviewConflictCode } = require('../src/lib/candidateErrors');
const { ResumeUploadError, inspectResumeFile, uploadResumeObject } = require('../src/lib/resumeUpload');
const {
  CandidateSubmissionKeyError,
  reserveCandidateSubmission,
  completeCandidateSubmission,
  failCandidateSubmission
} = require('../src/lib/candidateSubmissionIdempotency');
const { buildBrandedEmailShell, escapeHtml } = require('../utils/mailer');
const analyzeResume = require('../analyzeResume'); // resume analyzer

// uploads: keep in memory; 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// email config
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);
const SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_RATE_MAX = 10;

async function candidateSubmitRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'candidate_submit',
      subjectKey: getRequestSubjectKey(req),
      windowMs: SUBMIT_RATE_WINDOW_MS,
      maxCount: SUBMIT_RATE_MAX
    });
    if (!result.allowed) {
      return sendCandidateError(res, 'RATE_LIMITED', { request_id: req.request_id || null });
    }
  } catch (error) {
    console.error('[rate-limit] candidate submit check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id: req.request_id || null });
  }
  return next();
}

// 6-digit OTP
function six() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// normalize helpers
function normEmail(v = '') {
  return String(v || '').trim().toLowerCase();
}
function normName(v = '') {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function resumeMetadata(inspection) {
  if (!inspection) return {};
  return {
    resume_original_filename: inspection.original_filename,
    resume_size_bytes: inspection.size_bytes,
    resume_mime_type: inspection.mime_type,
    resume_sha256: inspection.sha256,
    resume_parse_status: inspection.parse_status,
    resume_parse_note: inspection.parse_note
  };
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
 * POST /api/candidate/submit
 * Accepts multipart form (resume) or JSON (resume_url).
 * Required: email + (name OR first/last) + (role_id OR role_token)
 */
router.post('/', candidateSubmitRateLimit, upload.any(), async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  let submissionReservation = null;
  Sentry.setTag('route_name', 'candidate_submit');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const respondFinal = async (status, payload, candidateId = null) => {
      await completeCandidateSubmission(supabaseAdmin, submissionReservation, {
        status,
        body: payload,
        candidateId
      });
      return res.status(status).json(payload);
    };
    const respondCandidateError = async (code, overrides = {}, candidateId = null) => {
      const { status, payload } = buildCandidateError(code, { ...overrides, request_id });
      return respondFinal(status, payload, candidateId);
    };
    const respondRetryableError = async (code, overrides = {}, candidateId = null) => {
      await failCandidateSubmission(supabaseAdmin, submissionReservation, { code, candidateId });
      return sendCandidateError(res, code, { ...overrides, request_id });
    };
    // --- normalize inputs ---
    const role_token   = (req.body.role_token || '').trim();
    const role_id_in   = (req.body.role_id || '').trim();
    const first_name   = (req.body.first_name || '').trim();
    const last_name    = (req.body.last_name  || '').trim();
    const rawName      = (req.body.name || '').trim();
    const emailRaw     = (req.body.email || '').trim();
    const phoneRaw     = (req.body.phone || '').trim();
    const phoneCountry = normalizeCandidatePhoneCountry(req.body.phone_country || req.body.phoneCountry || '');
    const submissionKey = req.body.submission_key || req.body.submissionKey || '';
    const resume_url_in = req.body.resume_url || null;
    const resumeFile = (req.files || []).find(file =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(file.fieldname)
    ) || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    const email = normEmail(emailRaw);
    const phone = normalizeCandidatePhone(phoneRaw, phoneCountry);
    const nameNorm = normName(fullName);

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).',
      });
    }
    if (!phone) {
      return sendCandidateError(res, 'INVALID_PHONE_FOR_COUNTRY', {
        detail: getCandidatePhoneValidationMessage(phoneCountry),
        request_id
      });
    }

    let resumeInspection = null;
    if (resumeFile) {
      try {
        resumeInspection = await inspectResumeFile(resumeFile);
      } catch (error) {
        if (error instanceof ResumeUploadError) {
          return sendCandidateError(res, error.code, { request_id });
        }
        throw error;
      }
    }

    // --- role lookup (need client_id + description) ---
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, job_description_text, kb_document_id, client_id, status')
        .eq('id', role_id_in)
        .single());
    } else {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, job_description_text, kb_document_id, client_id, status')
        .eq('slug_or_token', role_token)
        .single());
    }
    if (rErr || !role) {
      console.warn('[candidate-submit] role_not_found', {
        request_id,
        role_id: role_id_in || null
      });
      return sendCandidateError(res, 'INTERVIEW_LINK_EXPIRED', { request_id });
    }
    const roleId = role.id;
    sentryRoleId = roleId || null;
    sentryClientId = role.client_id || null;
    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'candidate_submit',
        request_id,
        role_id: roleId || null
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    Sentry.addBreadcrumb({
      category: 'candidate_submit',
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
        category: 'candidate_submit',
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
      roleTitle: role?.title || ''
    });
    if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
      Sentry.addBreadcrumb({
        category: 'candidate_submit',
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

    try {
      submissionReservation = await reserveCandidateSubmission(supabaseAdmin, {
        roleId,
        submissionKey
      });
    } catch (error) {
      if (error instanceof CandidateSubmissionKeyError) {
        return sendCandidateError(res, 'INVALID_SUBMISSION_KEY', { request_id });
      }
      console.error('[candidate-submit] idempotency_reservation_failed', {
        request_id,
        role_id: roleId,
        code: error?.code || null,
        error: error?.message || error
      });
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
    }
    if (submissionReservation.state === 'replay') {
      return res
        .status(Number(submissionReservation.row.response_status) || 200)
        .json(submissionReservation.row.response_body);
    }
    if (submissionReservation.state === 'processing') {
      return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', {
        status: 409,
        detail: 'This submission is still processing. Please wait a moment and try again.',
        request_id
      });
    }

    // --- duplicate & enrichment policy ---
    // RULES:
    // 1) Email match resolves to the existing identity. Recover OTP when no interview exists.
    // 2) If email does not match but name and phone do, require support review.
    // 3) Otherwise, ALLOW (create candidate, upload, send OTP).

    // 1) Email match
    let existingByEmail = null;
    {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone, verified, status, resume_url')
        .eq('role_id', roleId)
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByEmail = data;
    }
    if (existingByEmail) {
      // Enrich phone if missing
      if (phone && !existingByEmail.phone) {
        await supabase.from('candidates').update({ phone }).eq('id', existingByEmail.id);
      }
      const { data: existingInterview, error: existingInterviewError } = await supabase
        .from('interviews')
        .select('id,status')
        .eq('candidate_id', existingByEmail.id)
        .eq('role_id', roleId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingInterviewError) {
        return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, existingByEmail.id);
      }
      if (existingInterview) {
        return respondCandidateError(
          getInterviewConflictCode(existingInterview.status),
          {},
          existingByEmail.id
        );
      }
      {
        const candidate_id = existingByEmail.id;
        sentryCandidateId = candidate_id || null;
        if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
        console.log('[candidate-submit] duplicate_unverified_recovery_start', {
          request_id,
          candidate_id,
          role_id: roleId,
          recovery: true
        });

        if (!existingByEmail.resume_url && resumeFile && resumeInspection) {
          const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
          const objectPath = `${candidate_id}.${resumeInspection.extension}`;
          try {
            const resumeUrl = await uploadResumeObject({
              storage: supabase.storage,
              bucket,
              objectPath,
              file: resumeFile,
              inspection: resumeInspection
            });
            const { error: resumeUpdateError } = await supabase
              .from('candidates')
              .update({ resume_url: resumeUrl, ...resumeMetadata(resumeInspection) })
              .eq('id', candidate_id);
            if (resumeUpdateError) throw resumeUpdateError;
            existingByEmail.resume_url = resumeUrl;
          } catch (error) {
            await supabase.storage.from(bucket).remove([objectPath]).catch(() => {});
            console.error('[candidate-submit] recovery_resume_upload_failed', {
              request_id,
              candidate_id,
              role_id: roleId,
              code: error?.code || null
            });
            return respondRetryableError('RESUME_UPLOAD_FAILED', {}, candidate_id);
          }
        }

        const nowIso = new Date().toISOString();
        const { error: invalidateErr } = await supabase
          .from('otp_tokens')
          .update({ used: true, used_at: nowIso })
          .eq('candidate_email', email)
          .eq('role_id', roleId)
          .eq('used', false);
        if (invalidateErr) {
          console.error('[candidate-submit] duplicate_unverified_recovery_invalidate_failed', {
            request_id,
            candidate_id,
            role_id: roleId,
            email,
            error: invalidateErr.message,
            code: invalidateErr.code || null
          });
          return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
        }

        const freshCode = six();
        const { error: otpErr } = await supabase.from('otp_tokens').insert({
          candidate_email: email,
          role_id: roleId,
          code: freshCode,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          used: false,
        });
        if (otpErr) {
          console.error('otp create failed', {
            request_id,
            candidate_id,
            role_id: roleId,
            error: otpErr.message,
            code: otpErr.code || null
          });
          return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
        }

        console.log('[candidate-submit] duplicate_unverified_recovery_success', {
          request_id,
          candidate_id,
          role_id: roleId,
          recovery: true
        });
        const responseBody = {
          message: 'If your information is accepted, a verification code will be sent shortly.',
          candidate_id,
          role_id: roleId,
          resume_url: existingByEmail.resume_url || null,
          resume_parse_status: resumeInspection?.parse_status || null
        };
        await respondFinal(200, responseBody, candidate_id);

        setImmediate(async () => {
          console.log('[candidate-submit] duplicate_unverified_recovery_email_start', {
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
            console.log('[candidate-submit] duplicate_unverified_recovery_email_success', {
              request_id,
              candidate_id,
              role_id: roleId,
              email,
              status: resp?.statusCode || null
            });
          } catch (e) {
            const status = e?.response?.status || e?.code || null;
            const message = e?.message || 'send_failed';
            console.warn('[candidate-submit] duplicate_unverified_recovery_email_failure', {
              request_id,
              candidate_id,
              role_id: roleId,
              email,
              status,
              message
            });
            Sentry.captureException(e, {
              tags: {
                route_name: 'candidate_submit',
                surface: 'backend',
                task: 'duplicate_unverified_recovery_email',
                request_id: request_id || undefined,
                candidate_id: candidate_id || undefined,
                role_id: roleId || undefined,
                client_id: role?.client_id || undefined
              },
              extra: {
                request_id,
                candidate_id,
                role_id: roleId,
                client_id: role?.client_id || null,
                email,
                status,
                message
              }
            });
          }
        });
        return;
      }
    }

    // 2) Name + phone match with a different email requires recovery review.
    if (nameNorm && phone) {
      let existingByNamePhone = null;
      const { data, error } = await supabase
        .from('candidates')
        .select('id, phone')
        .eq('role_id', roleId)
        .eq('phone', phone)
        .ilike('name', fullName)
        .limit(1)
        .maybeSingle();
      if (!error && data) existingByNamePhone = data;

      if (existingByNamePhone) {
        return respondCandidateError('CANDIDATE_ALREADY_EXISTS', {}, existingByNamePhone.id);
      }
    }

    if (resumeInspection?.sha256) {
      const { data: matchingResume } = await supabase
        .from('candidates')
        .select('id')
        .eq('role_id', roleId)
        .eq('resume_sha256', resumeInspection.sha256)
        .limit(1)
        .maybeSingle();
      if (matchingResume) {
        console.warn('[candidate-submit] matching_resume_signal', {
          request_id,
          role_id: roleId,
          existing_candidate_id: matchingResume.id
        });
      }
    }

    // Upload first so a successful candidate row never points at a failed storage write.
    const candidate_id = crypto.randomUUID();
    let resume_url = resume_url_in;
    let uploadedObject = null;
    const fileBuf = resumeFile?.buffer || null;
    const fileType = resumeInspection?.mime_type || '';
    if (resumeFile && resumeInspection) {
      try {
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const objectPath = `${candidate_id}.${resumeInspection.extension}`;
        resume_url = await uploadResumeObject({
          storage: supabase.storage,
          bucket,
          objectPath,
          file: resumeFile,
          inspection: resumeInspection
        });
        uploadedObject = { bucket, objectPath };
      } catch (error) {
        console.error('[candidate-submit] resume_upload_failed', {
          request_id,
          role_id: roleId,
          code: error?.code || null
        });
        return respondRetryableError('RESUME_UPLOAD_FAILED');
      }
    }

    const { error: cErr } = await supabase
      .from('candidates')
      .insert({
        id: candidate_id,
        candidate_id,
        role_id: roleId,
        client_id: role.client_id || null,
        name: fullName,
        first_name,
        last_name,
        email,
        phone, // US: 10 digits; Philippines: 63 + mobile number.
        status: 'Resume Uploaded',
        resume_url: resume_url || null,
        ...resumeMetadata(resumeInspection)
      });
    if (cErr) {
      if (uploadedObject) {
        await supabase.storage.from(uploadedObject.bucket).remove([uploadedObject.objectPath]).catch(() => {});
      }
      console.error('[candidate-submit] candidate_insert_failed', {
        request_id,
        role_id: roleId,
        code: cErr.code || null,
        error: cErr.message
      });
      if (cErr.code === '23505') {
        return respondCandidateError('CANDIDATE_ALREADY_EXISTS');
      }
      return respondRetryableError('TEMPORARY_SERVICE_ERROR');
    }
    sentryCandidateId = candidate_id;
    Sentry.setTag('candidate_id', String(candidate_id));
    Sentry.addBreadcrumb({
      category: 'candidate_submit',
      message: 'candidate created',
      level: 'info',
      data: { candidate_id, role_id: roleId }
    });

    // --- OTP hardening: invalidate old + create fresh ---
    const nowIso = new Date().toISOString();
    const { error: invalidateErr } = await supabase
      .from('otp_tokens')
      .update({ used: true, used_at: nowIso })
      .eq('candidate_email', email)
      .eq('role_id', roleId)
      .eq('used', false);
    if (invalidateErr) {
      console.error('[candidate-submit] otp_invalidate_failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        code: invalidateErr.code || null
      });
      return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
    }

    const freshCode = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email,
      role_id: roleId,
      code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    });
    if (otpErr) {
      console.error('otp create failed', {
        request_id,
        candidate_id,
        role_id: roleId,
        error: otpErr.message,
        code: otpErr.code || null
      });
      return respondRetryableError('TEMPORARY_SERVICE_ERROR', {}, candidate_id);
    }

    // success
    await respondFinal(200, {
      message: 'If your information is accepted, a verification code will be sent shortly.',
      candidate_id,
      role_id: roleId,
      resume_url: resume_url || null,
      resume_parse_status: resumeInspection?.parse_status || null
    }, candidate_id);

    setImmediate(async () => {
      console.log('[candidate-submit] background_otp_email_start', {
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
        console.log('[candidate-submit] background_otp_email_success', {
          request_id,
          candidate_id,
          role_id: roleId,
          email,
          status: resp?.statusCode || null
        });
      } catch (e) {
        const status = e?.response?.status || e?.code || null;
        const message = e?.message || 'send_failed';
        console.warn('[candidate-submit] background_otp_email_failed', {
          request_id,
          candidate_id,
          role_id: roleId,
          email,
          status,
          message
        });
        Sentry.addBreadcrumb({
          category: 'candidate_submit',
          message: 'otp send failed',
          level: 'warning',
          data: { request_id, status, message, candidate_id, role_id: roleId }
        });
        Sentry.captureException(e, {
          tags: {
            route_name: 'candidate_submit',
            surface: 'backend',
            task: 'background_otp_email',
            request_id: request_id || undefined,
            candidate_id: candidate_id || undefined,
            role_id: roleId || undefined,
            client_id: role?.client_id || undefined
          },
          extra: {
            request_id,
            candidate_id,
            role_id: roleId,
            client_id: role?.client_id || null,
            email,
            status,
            message
          }
        });
      }
    });

    if (fileBuf && resumeInspection?.parse_status === 'parsed') {
      setImmediate(async () => {
        console.log('[candidate-submit] background_resume_analysis_start', {
          request_id,
          candidate_id,
          role_id: roleId,
          email
        });
        try {
          const summary = await analyzeResume(fileBuf, fileType, {
            ...role,
            description: role.description || role.job_description_text || ''
          }, candidate_id);
          await supabase.from('candidates').update({ analysis_summary: summary }).eq('id', candidate_id);
          console.log('[candidate-submit] background_resume_analysis_success', {
            request_id,
            candidate_id,
            role_id: roleId,
            email
          });
        } catch (e) {
          console.warn('[candidate-submit] background_resume_analysis_failed', {
            request_id,
            candidate_id,
            role_id: roleId,
            email,
            error: e?.message || e
          });
          Sentry.captureException(e, {
            tags: {
              route_name: 'candidate_submit',
              surface: 'backend',
              task: 'background_resume_analysis',
              request_id: request_id || undefined,
              candidate_id: candidate_id || undefined,
              role_id: roleId || undefined,
              client_id: role?.client_id || undefined
            },
            extra: {
              request_id,
              candidate_id,
              role_id: roleId,
              client_id: role?.client_id || null,
              email
            }
          });
        }
      });
    }
    return;
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    Sentry.captureException(err, {
      tags: {
        route_name: 'candidate_submit',
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
    try {
      await failCandidateSubmission(supabaseAdmin, submissionReservation, {
        code: 'TEMPORARY_SERVICE_ERROR',
        candidateId: sentryCandidateId
      });
    } catch (_) {}
    return sendCandidateError(res, 'TEMPORARY_SERVICE_ERROR', { request_id });
  }
});

module.exports = router;
