const sg = require('@sendgrid/mail');
const { buildBrandedEmailShell, escapeHtml } = require('./mailer');

async function sendEmailOtp({ to, code, from, appName }) {
  const key = process.env.SENDGRID_API_KEY;
  const fromEmail = from || process.env.SENDGRID_FROM;
  if (!key) throw new Error('SENDGRID_API_KEY missing');
  if (!fromEmail) throw new Error('SENDGRID_FROM missing');
  sg.setApiKey(key);

  const subject = `${appName || 'Interview Agent'} verification code: ${code}`;
  const text = `Your verification code is ${code}. It expires in 10 minutes.`;
  const safeAppName = escapeHtml(appName || 'Interview Agent');
  const safeCode = escapeHtml(code || '');
  const html = buildBrandedEmailShell({
    title: 'Your verification code',
    preheader: `Your verification code is ${safeCode}. It expires in 10 minutes.`,
    contentHtml: `
      <p style="margin:0 0 14px;color:#C9D3FF;font-size:15px;line-height:1.6;">
        Use this one-time code to continue your ${safeAppName} verification.
      </p>
      <p style="margin:0 0 16px;">
        <span style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:10px 16px;font-size:22px;font-weight:800;letter-spacing:0.22em;">
          ${safeCode}
        </span>
      </p>
      <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
        This code expires in 10 minutes.
      </p>
    `
  });

  const [resp] = await sg.send({ to, from: fromEmail, subject, text, html });
  return resp?.statusCode || 202;
}

module.exports = { sendEmailOtp };
