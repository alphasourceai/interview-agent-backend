import sgMail from '@sendgrid/mail';

const {
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL = 'info@alphasourceai.com',
  SENDGRID_FROM_NAME = 'alphaSource Interview Agent',
  SENDGRID_TEMPLATE_INVITE,
  SENDGRID_TEMPLATE_RESET,
  SENDGRID_TEMPLATE_WELCOME,
} = process.env;

if (!SENDGRID_API_KEY) {
  throw new Error('Missing SENDGRID_API_KEY');
}
sgMail.setApiKey(SENDGRID_API_KEY);

export async function sendEmail({ to, templateId, dynamicTemplateData }) {
  const msg = {
    to,
    from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
    templateId,
    dynamicTemplateData,
  };
  const [res] = await sgMail.send(msg);
  return { status: res.statusCode };
}

export async function sendInviteEmail({ to, name, invite_link }) {
  if (!SENDGRID_TEMPLATE_INVITE) throw new Error('Missing SENDGRID_TEMPLATE_INVITE');
  return sendEmail({
    to,
    templateId: SENDGRID_TEMPLATE_INVITE,
    dynamicTemplateData: { name, invite_link },
  });
}

export async function sendPasswordResetEmail({ to, name, reset_link }) {
  if (!SENDGRID_TEMPLATE_RESET) throw new Error('Missing SENDGRID_TEMPLATE_RESET');
  return sendEmail({
    to,
    templateId: SENDGRID_TEMPLATE_RESET,
    dynamicTemplateData: { name, reset_link },
  });
}

export async function sendWelcomeEmail({ to, name, dashboard_url = 'https://www.alphasourceai.com/account' }) {
  if (!SENDGRID_TEMPLATE_WELCOME) throw new Error('Missing SENDGRID_TEMPLATE_WELCOME');
  return sendEmail({
    to,
    templateId: SENDGRID_TEMPLATE_WELCOME,
    dynamicTemplateData: { name, dashboard_url },
  });
}