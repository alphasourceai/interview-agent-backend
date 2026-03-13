// utils/mailer.js
const sg = require('@sendgrid/mail')

const API_KEY = process.env.SENDGRID_API_KEY
if (!API_KEY) {
  // Don't crash app in prod if not configured; calling code can handle
  console.warn('[mailer] SENDGRID_API_KEY not set; emails will be skipped')
} else {
  sg.setApiKey(API_KEY)
}

const FROM = process.env.SENDGRID_FROM || 'no-reply@yourdomain.com'

async function sendInvite(to, acceptUrl, inviterEmail) {
  if (!API_KEY) return { skipped: true }
  const msg = {
    to,
    from: FROM,
    subject: 'You’ve been invited to Interview Agent',
    html: `
      <p>You’ve been invited to join a client account on Interview Agent.</p>
      <p><a href="${acceptUrl}" target="_blank" rel="noopener">Accept your invite</a></p>
      ${inviterEmail ? `<p>Invited by: ${inviterEmail}</p>` : ''}
      <hr />
      <p>This link will sign you in and associate your account with the correct client.</p>
    `,
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendSubscriptionCheckoutEmail(to, checkoutUrl) {
  if (!API_KEY) return { skipped: true }
  const msg = {
    to,
    from: FROM,
    subject: 'Complete your subscription checkout',
    html: `
      <p>Please complete your subscription checkout using the secure Stripe link below.</p>
      <p><a href="${checkoutUrl}" target="_blank" rel="noopener">Complete subscription checkout</a></p>
      <p>If the button does not work, copy and paste this URL into your browser:</p>
      <p>${checkoutUrl}</p>
    `,
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

module.exports = { sendInvite, sendSubscriptionCheckoutEmail }
