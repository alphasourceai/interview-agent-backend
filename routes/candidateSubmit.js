// routes/candidateSubmit.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sg = require('@sendgrid/mail');
const { supabase } = require('../src/lib/supabaseClient');
const analyzeResume = require('../analyzeResume'); // <-- add

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const FROM_EMAIL = process.env.SENDGRID_FROM;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const APP_NAME = process.env.APP_NAME || 'Interview Agent';
if (SENDGRID_KEY) sg.setApiKey(SENDGRID_KEY);

function six() { return String(Math.floor(100000 + Math.random() * 900000)); }

router.post('/', upload.any(), async (req, res) => {
  try {
    const role_token = (req.body.role_token || '').trim();
    const role_id_in = (req.body.role_id || '').trim();
    const first_name = (req.body.first_name || '').trim();
    const last_name  = (req.body.last_name  || '').trim();
    const rawName    = (req.body.name || '').trim();
    const email      = (req.body.email || '').trim().toLowerCase();
    const phone      = (req.body.phone || '').replace(/\D/g, '');
    const resume_url_in = req.body.resume_url || null;

    const fullName = rawName || [first_name, last_name].filter(Boolean).join(' ').trim();
    if (!email || !fullName || (!role_token && !role_id_in)) {
      return res.status(400).json({ error: 'Required: email, (name OR first_name+last_name), and (role_id OR role_token).' });
    }

    // role (need description for analysis)
    let role = null, rErr = null;
    if (role_id_in) {
      ({ data: role, error: rErr } = await supabase.from('roles')
        .select('id, title, description, kb_document_id').eq('id', role_id_in).single());
    } else {
      ({ data: role, error: rErr } = await supabase.from('roles')
        .select('id, title, description, kb_document_id').eq('slug_or_token', role_token).single());
    }
    if (rErr || !role) return res.status(404).json({ error: 'Role not found.' });
    const roleId = role.id;

    // duplicate guard
    const { count: dupCount, error: dupErr } = await supabase
      .from('candidates').select('*', { count: 'exact', head: true })
      .eq('email', email).eq('role_id', roleId);
    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if ((dupCount || 0) > 0) {
      // still send a fresh OTP and return
      await supabase.from('otp_tokens')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('candidate_email', email).eq('role_id', roleId).eq('used', false);
      const code = six();
      await supabase.from('otp_tokens').insert({
        candidate_email: email, role_id: roleId, code,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false
      });
      let emailErr = null, emailOk = false;
      try {
        if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
        const [resp] = await sg.send({
          to: email, from: { email: FROM_EMAIL, name: APP_NAME },
          subject: `Your ${APP_NAME} verification code`,
          text: `Your verification code is ${code}. It expires in 10 minutes.`,
          html: `<p>Your verification code is <strong style="font-size:18px">${code}</strong>.</p><p>It expires in 10 minutes.</p>`
        });
        emailOk = resp?.statusCode === 202;
      } catch (e) { emailErr = e?.response?.data || e?.message || String(e); }
      return res.status(409).json({
        error: 'You have already started an interview for this role.',
        email_sent: emailOk, email_error: emailErr, email
      });
    }

    // create candidate (now including first/last) …
    const { data: inserted, error: cErr } = await supabase
      .from('candidates')
      .insert({ role_id: roleId, name: fullName, first_name, last_name, email, phone, status: 'Resume Uploaded' })
      .select('id')
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    const candidate_id = inserted.id;

    // self-reference candidate_id
    await supabase.from('candidates').update({ candidate_id }).eq('id', candidate_id);

    // upload resume (if provided)
    let resume_url = resume_url_in;
    let fileBuf = null, fileType = '';
    try {
      const file = (req.files || []).find(f =>
        ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
      );
      if (file) {
        fileBuf = file.buffer; fileType = file.mimetype || 'application/pdf';
        const bucket = process.env.SUPABASE_RESUMES_BUCKET || 'resumes';
        const path = `${candidate_id}.${/pdf/i.test(fileType) ? 'pdf' : 'docx'}`;
        const up = await supabase.storage.from(bucket).upload(path, file.buffer, {
          contentType: fileType, upsert: true,
        });
        if (!up.error) {
          const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
          resume_url = pub?.publicUrl || resume_url;
        }
      }
    } catch (e) {
      console.error('resume upload failed:', e?.message || e);
    }
    if (resume_url) await supabase.from('candidates').update({ resume_url }).eq('id', candidate_id);

    // ANALYZE RESUME (non-fatal)
    try {
      if (fileBuf) {
        const analysis = await analyzeResume(fileBuf, fileType, { title: role.title, description: role.description }, candidate_id);
        await supabase.from('candidates').update({ analysis_summary: analysis }).eq('id', candidate_id);
      }
    } catch (e) {
      console.warn('resume analysis failed:', e?.message || e);
    }

    // OTP hardening: invalidate old + create one
    const nowIso = new Date().toISOString();
    await supabase.from('otp_tokens')
      .update({ used: true, used_at: nowIso })
      .eq('candidate_email', email).eq('role_id', roleId).eq('used', false);

    const freshCode = six();
    const { error: otpErr } = await supabase.from('otp_tokens').insert({
      candidate_email: email, role_id: roleId, code: freshCode,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false
    });
    if (otpErr) return res.status(500).json({ error: `Could not create OTP: ${otpErr.message}` });

    // email newest OTP
    let emailSent = false, emailError = null;
    try {
      if (!SENDGRID_KEY || !FROM_EMAIL) throw new Error('SENDGRID_API_KEY or SENDGRID_FROM not configured');
      const [resp] = await sg.send({
        to: email, from: { email: FROM_EMAIL, name: APP_NAME },
        subject: `Your ${APP_NAME} verification code`,
        text: `Your verification code is ${freshCode}. It expires in 10 minutes.`,
        html: `<p>Your verification code is <strong style="font-size:18px">${freshCode}</strong>.</p>
               <p>It expires in 10 minutes.</p>`
      });
      emailSent = resp?.statusCode === 202;
    } catch (e) {
      emailError = e?.response?.data || e?.message || String(e);
      console.error('sendEmailOtp failed:', emailError);
    }

    return res.status(200).json({
      message: emailSent ? 'Candidate created. OTP emailed.' : 'Candidate created. OTP email failed.',
      email_sent: emailSent,
      email_error: emailError,
      candidate_id, role_id: roleId, email, resume_url: resume_url || null
    });
  } catch (err) {
    console.error('Error in /candidate/submit:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
