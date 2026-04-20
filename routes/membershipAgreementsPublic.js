'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { htmlToPdf } = require('../utils/pdfRenderer');
const {
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
} = require('../utils/renderMembershipAgreement');
const {
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification
} = require('../utils/mailer');

const router = express.Router();

const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements';
const MEMBERSHIP_INTERNAL_NOTIFY_EMAIL = 'memberships@alphasourceai.com';
const SIGNED_URL_TTL_SECONDS = Math.max(60, Number(process.env.SIGNED_URL_TTL_SECONDS || 600));
const EMAIL_SIGNED_URL_TTL_SECONDS = Math.max(300, Number(process.env.AGREEMENT_SIGNED_EMAIL_LINK_TTL_SECONDS || 604800));

function extractErrorMessage(text, fallback) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed?.detail || parsed?.message || parsed?.error;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch (_) {}
  return raw;
}

function readToken(req) {
  return String(req.body?.token || '').trim();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'client';
}

function normalizeAccepted(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0] || '').trim();
    if (first) return first;
  }

  return String(req.ip || '').trim() || null;
}

function parseSignaturePayload(raw) {
  const source = String(raw || '').trim();
  if (!source) {
    const err = new Error('signature_required');
    err.code = 'signature_required';
    throw err;
  }

  const match = source.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }

  const mimeRaw = String(match[1] || '').toLowerCase();
  const mime = mimeRaw === 'image/jpg' ? 'image/jpeg' : mimeRaw;
  const base64 = String(match[2] || '').replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }
  if (buffer.length > 2 * 1024 * 1024) {
    const err = new Error('signature_too_large');
    err.code = 'signature_too_large';
    throw err;
  }

  const ext = mime === 'image/png'
    ? 'png'
    : mime === 'image/webp'
      ? 'webp'
      : 'jpg';

  return {
    mime,
    ext,
    base64,
    buffer,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

function isExpired(isoTime) {
  if (!isoTime) return false;
  const ts = Date.parse(String(isoTime));
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now();
}

function validateSignableAgreement(row) {
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'token_invalid',
      detail: 'This signing link is invalid.'
    };
  }

  if (String(row.status || '').toLowerCase() !== 'sent') {
    return {
      ok: false,
      status: 409,
      code: 'agreement_not_signable',
      detail: 'This agreement is no longer available for signing.'
    };
  }

  if (isExpired(row.signer_token_expires_at)) {
    return {
      ok: false,
      status: 410,
      code: 'token_expired',
      detail: 'This signing link has expired.'
    };
  }

  return { ok: true };
}

function buildAgreementInputFromRow(row) {
  const snapshotValues =
    row?.template_snapshot &&
    typeof row.template_snapshot === 'object' &&
    row.template_snapshot.values &&
    typeof row.template_snapshot.values === 'object'
      ? row.template_snapshot.values
      : null;

  if (snapshotValues) {
    return normalizeMembershipAgreementInput(snapshotValues);
  }

  return normalizeMembershipAgreementInput({
    client_id: row?.client_id || null,
    client_legal_name: row?.client_legal_name || '',
    dba_trade_name: row?.dba_trade_name || '',
    primary_admin_name: row?.primary_admin_name || '',
    admin_email: row?.admin_email || '',
    membership_tier: row?.membership_tier || '',
    initial_term_start: row?.initial_term_start || '',
    initial_renewal_date: row?.initial_renewal_date || '',
    billing_option: row?.billing_option || '',
    auto_renew: row?.auto_renew,
    notice_deadline_days: row?.notice_deadline_days
  });
}

async function createAgreementSignedUrl(path, expiresInSeconds) {
  const key = String(path || '').trim();
  if (!key) return null;
  const { data, error } = await supabaseAdmin
    .storage
    .from(AGREEMENTS_BUCKET)
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadAgreementByTokenHash(tokenHash) {
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,status,client_legal_name,dba_trade_name,primary_admin_name,admin_email,membership_tier,initial_term_start,initial_renewal_date,billing_option,auto_renew,notice_deadline_days,template_snapshot,draft_pdf_path,executed_pdf_path,signer_token_expires_at,opened_at,sent_at,signed_at,signer_typed_name')
    .eq('signer_token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message || 'agreement_lookup_failed');
    err.code = error.code || 'agreement_lookup_failed';
    err.hint = error.hint || null;
    throw err;
  }

  return data || null;
}

router.post('/session', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const validation = validateSignableAgreement(agreement);
    if (!validation.ok) {
      return res.status(validation.status).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }

    let openedAt = agreement.opened_at || null;
    if (!openedAt) {
      openedAt = new Date().toISOString();
      const { error: openedErr } = await supabaseAdmin
        .from('membership_agreements')
        .update({ opened_at: openedAt, updated_at: openedAt })
        .eq('id', agreement.id);
      if (openedErr) {
        console.error('[membership-agreements/session] opened_at_update_failed', {
          request_id,
          agreement_id: agreement.id,
          error: openedErr.message,
          code: openedErr.code
        });
      }
    }

    const draftPdfUrl = await createAgreementSignedUrl(agreement.draft_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      session: {
        agreement_id: agreement.id,
        client_legal_name: agreement.client_legal_name,
        dba_trade_name: agreement.dba_trade_name,
        primary_admin_name: agreement.primary_admin_name,
        admin_email: agreement.admin_email,
        membership_tier: agreement.membership_tier,
        billing_option: agreement.billing_option,
        auto_renew: agreement.auto_renew,
        notice_deadline_days: agreement.notice_deadline_days,
        initial_term_start: agreement.initial_term_start,
        initial_renewal_date: agreement.initial_renewal_date,
        expires_at: agreement.signer_token_expires_at,
        sent_at: agreement.sent_at,
        opened_at: openedAt,
        draft_pdf_url: draftPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/session] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});

router.post('/sign', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const typedName = String(req.body?.typed_name || req.body?.typedName || '').trim();
    if (!typedName) {
      return res.status(400).json({
        error: 'typed_name_required',
        code: 'typed_name_required',
        detail: 'Typed name is required.',
        request_id
      });
    }

    const accepted = normalizeAccepted(req.body?.accepted ?? req.body?.agreement_accepted ?? req.body?.agreementAccepted);
    if (!accepted) {
      return res.status(400).json({
        error: 'agreement_acceptance_required',
        code: 'agreement_acceptance_required',
        detail: 'Agreement acceptance checkbox is required.',
        request_id
      });
    }

    let signaturePayload;
    try {
      signaturePayload = parseSignaturePayload(req.body?.signature_image || req.body?.signatureImage || req.body?.signature_image_data_url || req.body?.signatureDataUrl);
    } catch (signatureErr) {
      return res.status(400).json({
        error: signatureErr.code || 'signature_invalid',
        code: signatureErr.code || 'signature_invalid',
        detail: 'A drawn signature image is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const validation = validateSignableAgreement(agreement);
    if (!validation.ok) {
      return res.status(validation.status).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }

    const signedAt = new Date().toISOString();
    const signatureSha256 = crypto.createHash('sha256').update(signaturePayload.buffer).digest('hex');
    const clientSlug = slugify(agreement.client_legal_name);
    const signaturePath = `membership-agreements/${agreement.id}/signature.${signaturePayload.ext}`;

    const signatureUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(signaturePath, signaturePayload.buffer, {
        contentType: signaturePayload.mime,
        upsert: true
      });

    if (signatureUpload.error) {
      console.error('[membership-agreements/sign] signature_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: signatureUpload.error.message,
        code: signatureUpload.error.code
      });
      return res.status(500).json({
        error: 'signature_upload_failed',
        code: signatureUpload.error.code || 'signature_upload_failed',
        detail: signatureUpload.error.message,
        request_id
      });
    }

    const agreementInput = buildAgreementInputFromRow(agreement);
    const { html } = buildMembershipAgreementHtml(agreementInput, {
      execution: {
        accepted: true,
        signer_typed_name: typedName,
        signature_image_src: signaturePayload.dataUrl,
        signed_at: signedAt
      }
    });

    const executedPdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    });

    const executedPdfPath = `membership-agreements/${agreement.id}/${clientSlug}-executed.pdf`;
    const executedUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(executedPdfPath, executedPdf, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (executedUpload.error) {
      console.error('[membership-agreements/sign] executed_pdf_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: executedUpload.error.message,
        code: executedUpload.error.code
      });
      return res.status(500).json({
        error: 'executed_pdf_upload_failed',
        code: executedUpload.error.code || 'executed_pdf_upload_failed',
        detail: executedUpload.error.message,
        request_id
      });
    }

    const ipAddress = getClientIp(req);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 1024) || null;
    const nextTemplateSnapshot = {
      ...(agreement.template_snapshot && typeof agreement.template_snapshot === 'object' ? agreement.template_snapshot : {}),
      execution: {
        signed_at: signedAt,
        signer_typed_name: typedName,
        signer_accepted: true,
        signature_sha256: signatureSha256,
        signature_image_path: signaturePath,
        executed_pdf_path: executedPdfPath,
        signer_ip: ipAddress,
        signer_user_agent: userAgent
      }
    };

    const { data: updatedAgreement, error: updateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update({
        status: 'signed',
        opened_at: agreement.opened_at || signedAt,
        signed_at: signedAt,
        signer_typed_name: typedName,
        signer_accepted: true,
        signature_image_path: signaturePath,
        signature_sha256: signatureSha256,
        signer_ip: ipAddress,
        signer_user_agent: userAgent,
        executed_pdf_path: executedPdfPath,
        template_snapshot: nextTemplateSnapshot,
        updated_at: signedAt
      })
      .eq('id', agreement.id)
      .eq('status', 'sent')
      .select('id,client_id,status,signed_at,signer_typed_name,client_legal_name,primary_admin_name,admin_email,executed_pdf_path')
      .maybeSingle();

    if (updateErr) {
      console.error('[membership-agreements/sign] status_update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: updateErr.message,
        code: updateErr.code,
        hint: updateErr.hint
      });
      return res.status(500).json({
        error: 'status_update_failed',
        code: updateErr.code || 'status_update_failed',
        detail: updateErr.message,
        hint: updateErr.hint,
        request_id
      });
    }

    if (!updatedAgreement) {
      return res.status(409).json({
        error: 'agreement_not_signable',
        code: 'agreement_not_signable',
        detail: 'This agreement was already signed or is no longer signable.',
        request_id
      });
    }

    const emailDownloadUrl = await createAgreementSignedUrl(executedPdfPath, EMAIL_SIGNED_URL_TTL_SECONDS);
    const responseDownloadUrl = await createAgreementSignedUrl(executedPdfPath, SIGNED_URL_TTL_SECONDS);

    try {
      await sendMembershipAgreementSignedCopyEmail(updatedAgreement.admin_email, {
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        signer_typed_name: typedName,
        signed_at: signedAt,
        executed_pdf_url: emailDownloadUrl,
        pdf_base64: executedPdf.toString('base64'),
        file_name: `${clientSlug}-membership-agreement-signed.pdf`
      });
    } catch (emailErr) {
      console.error('[membership-agreements/sign] signed_copy_email_failed', {
        request_id,
        agreement_id: agreement.id,
        error: emailErr?.message || emailErr
      });
    }

    try {
      await sendMembershipAgreementCompletedInternalNotification(MEMBERSHIP_INTERNAL_NOTIFY_EMAIL, {
        agreement_id: updatedAgreement.id,
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        admin_email: updatedAgreement.admin_email,
        signer_typed_name: typedName,
        signed_at: signedAt
      });
    } catch (notifyErr) {
      console.error('[membership-agreements/sign] internal_completion_email_failed', {
        request_id,
        agreement_id: agreement.id,
        error: notifyErr?.message || notifyErr
      });
    }

    return res.json({
      ok: true,
      agreement: {
        id: updatedAgreement.id,
        status: updatedAgreement.status,
        signed_at: updatedAgreement.signed_at,
        signer_typed_name: updatedAgreement.signer_typed_name
      },
      executed_pdf_url: responseDownloadUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/sign] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});

router.get('/latest-signed', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const scopedIds = Array.isArray(req.client_memberships)
      ? req.client_memberships
      : (Array.isArray(req.clientIds) ? req.clientIds : []);
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
    if (!isGlobalAdmin && !scopedIds.includes(clientId)) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Client scope mismatch.',
        request_id
      });
    }

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,client_id,status,signed_at,signer_typed_name,client_legal_name,executed_pdf_path,created_at')
      .eq('client_id', clientId)
      .eq('status', 'signed')
      .order('signed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed] query_failed', {
        request_id,
        client_id: clientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement: {
        id: latest.id,
        client_id: latest.client_id,
        status: latest.status,
        signed_at: latest.signed_at,
        signer_typed_name: latest.signer_typed_name,
        client_legal_name: latest.client_legal_name,
        executed_pdf_url: executedPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

router.get('/latest-signed-url', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const scopedIds = Array.isArray(req.client_memberships)
      ? req.client_memberships
      : (Array.isArray(req.clientIds) ? req.clientIds : []);
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
    if (!isGlobalAdmin && !scopedIds.includes(clientId)) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Client scope mismatch.',
        request_id
      });
    }

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,executed_pdf_path,created_at,signed_at')
      .eq('client_id', clientId)
      .eq('status', 'signed')
      .order('signed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed-url] query_failed', {
        request_id,
        client_id: clientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement_id: latest.id,
      executed_pdf_url: executedPdfUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed-url] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

module.exports = router;
