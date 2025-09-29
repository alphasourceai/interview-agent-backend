// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabase } = require('../src/lib/supabaseClient');
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
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

// 6-digit OTP
function six() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// normalize helpers
function normEmail(v = '') {
  return String(v || '').trim().toLowerCase();
}
function normPhone(v = '') {
  return String(v || '').replace(/\D/g, '');
}
function normName(v = '') {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * POST /api/candidate/submit
 * Accepts multipart form (resume) or JSON (resume_url).
 * Required: email + (name OR first/last) + (role_id OR role_token)
 */
router.post('/', upload.any(), async (req, res) => {
  try {
    // --- normalize inputs ---
    const role_token   = (req.body.role_token || '').trim();
    const role_id_in   = (req.body.role_id || '').trim();
    const first_name   = (req.body.first_name || '').trim();
    const last_name    = (req.body.last_name  || '').trim();
    const rawName      = (req.body.name || '').trim();
    const emailRaw     = (req.body.email || '').trim();
    const phoneRaw     = (req.body.phone || '').trim();
    const resume_url_in = req.body.resume_url || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();

    const email = normEmail(emailRaw);
    const phone = normPhone(phoneRaw);
    const nameNorm = normName(fullName);

    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({
        error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).',
      });
    }

    // --- role lookup (need client_id + description) ---
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, kb_document_id, client_id')
        .eq('id', role_id_in)
        .single());
    } else {
      ({ data: role, error: rErr } = await supabase
        .from('roles')
        .select('id, title, description, kb_document_id, client_id')
        .eq('slug_or_token', role_token)
        .single());
    }
    if (rErr || !role) return res.status(404).json({ error: 'Role not found.' });
    const roleId = role.id;

    // --- duplicate & enrichment policy ---
    // 1) Try exact email match for this role
    let existing = null;
    {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone')
        .eq('role_id', roleId)
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (!error && data) existing = data;
    }
    // 2) If not found and we have phone, try phone match
    if (!existing && phone) {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone')
        .eq('role_id', roleId)
        .eq('phone', phone)
        .limit(1)
        .maybeSingle();
      if (!error && data) existing = data;
    }
    // 3) If still not found, try case-insensitive name match
    if (!existing) {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, phone')
        .eq('role_id', roleId)
        .ilike('name', fullName); // ilike is case-insensitive exact when no wildcards
      if (!error && Array.isArray(data) && data.length) existing = data[0];
    }

    // Branching:
    // A) If an existing record is found AND both name & email match (case-insensitive),
    //    enrich phone if provided and missing, then proceed using existing.id.
    // B) Otherwise, block as duplicate and DO NOT send OTP.
    let candidate_id = null;
    if (existing) {
      const existingNameNorm = normName(existing.name || '');
      const existingEmailNorm = normEmail(existing.email || '');
      const nameEmailMatch = (existingNameNorm === nameNorm) && (existingEmailNorm === email);

      if (nameEmailMatch) {
        candidate_id = existing.id;
        // Enrich phone if we have one and it's missing on the record
        if (phone && !existing.phone) {
          await supabase.from('candidates').update({ phone }).eq('id', candidate_id);
        }
      } else {
        return res.status(409).json({
          error: "You’ve already interviewed for this role with this information. If you believe this is an error, contact support at info@alphasourceai.com",
        });
      }
    }

    // --- create candidate if needed (denormalize client_id) ---
    if (!candidate_id) {
      const { data: inserted, error: cErr } = await supabase
        .from('candidates')
        .insert({
          role_id: roleId,
          client_id: role.client_id || null,
          name: fullName,
          first_name,
          last_name,
          email,
          phone,
          status: 'Resume Uploaded',
        })
        .select('id')
        .single();
      if (cErr) return res.status(500).json({ error: cErr.message });
      candidate_id = inserted.id;

      // self-reference (candidate_id column)
      await supabase.from('candidates').update({ candidate_id }).eq('id', candidate_id);
    }

    // --- resume upload (optional) ---
    let resume_url = resume_url_in;
    let fileBuf = null, fileType = '';
    try {
      const file = (req.files || []).find(f =>
        ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
      );
      if (file) {
        fileBuf = file.buffer;
        fileType = file.mimetype || 'application/pdf';
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
        const path = `${candidate_id}.${ext}`;

        const up = await supabase.storage.from(bucket).upload(path, file.buffer, {
          contentType: fileType,
          upsert: true,
        });
        if (!up.error) {
          const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
          resume_url = pub?.publicUrl || resume_url;
        }
      }
    } catch (e) {
      console.error('resume upload failed:', e?.message || e);
    }
    if (resume_url) {
      await supabase.from('candidates').update({ resume_url }).eq('id', candidate_id);
    }

    // --- analyze resume (non-fatal) ---
    try {
      if (fileBuf) {
        const summary = await analyzeResume(fileBuf, fileType, role, candidate_id);
        await supabase.from('candidates').update({ analysis_summary: summary }).eq('id', candidate_id);
      }
    } catch (e) {
      console.warn('resume analysis failed:', e?.message || e);
    }

    // --- OTP hardening: invalidate old + create fresh ---
    const nowIso = new Date().toISOString();
    await supabase
      .from('otp_tokens')
      .update({ used: true, used_at: nowIso })
      .eq('candidate_email', email)
      .eq('role_id', roleId)
      .eq('used', false);

    const freshCode = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email,
      role_id: roleId,
      code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    });
    if (otpErr) return res.status(500).json({ error: `Could not create OTP: ${otpErr.message}` });

    // --- email OTP (non-fatal) ---
    let emailSent = false, emailError = null;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const [resp] = await sg.send({
        to: email,
        from: { email: FROM_EMAIL, name: APP_NAME },
        subject: `Your ${APP_NAME} verification code`,
        text: `Your verification code is ${freshCode}. It expires in 10 minutes.`,
        html: `<p>Your verification code is <strong style="font-size:18px">${freshCode}</strong>.</p>
               <p>It expires in 10 minutes.</p>`,
      });
      emailSent = resp?.statusCode === 202;
    } catch (e) {
      emailError = e?.response?.data || e?.message || String(e);
      console.error('sendEmailOtp failed:', emailError);
    }

    // success
    return res.status(200).json({
      message: emailSent ? 'Candidate created. OTP emailed.' : 'Candidate created. OTP email failed.',
      email_sent: emailSent,
      email_error: emailError,
      candidate_id,
      role_id: roleId,
      email,
      resume_url: resume_url || null,
    });
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
