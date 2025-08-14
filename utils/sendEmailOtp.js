const sg = require('@sendgrid/mail');

async function sendEmailOtp({ to, code, from, appName }) {
  const key = process.env.SENDGRID_API_KEY;
  const fromEmail = from || process.env.SENDGRID_FROM;
  if (!key) throw new Error('SENDGRID_API_KEY missing');
  if (!fromEmail) throw new Error('SENDGRID_FROM missing');
  sg.setApiKey(key);

  const subject = `${appName || 'Interview Agent'} verification code: ${code}`;
  const text = `Your verification code is ${code}. It expires in 10 minutes.`;
  const html = `<p>Your verification code is <strong style="font-size:18px">${code}</strong>.</p>
                <p>It expires in 10 minutes.</p>`;

  const [resp] = await sg.send({ to, from: fromEmail, subject, text, html });
  return resp?.statusCode || 202;
}

module.exports = { sendEmailOtp };
