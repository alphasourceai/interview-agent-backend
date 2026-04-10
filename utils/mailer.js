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

async function sendPasswordResetEmail(to, resetUrl) {
  if (!API_KEY) return { skipped: true }
  const safeResetUrl = resetUrl
  const msg = {
    to,
    from: FROM,
    subject: 'Reset your alphaScreen password',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Reset your alphaScreen password</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
          @media (max-width: 640px) {
            .container { width: 100% !important; padding: 16px !important; }
            .card { padding: 18px !important; border-radius: 14px !important; }
            .cta { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
          }
        </style>
      </head>
      <body>
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          Reset your alphaScreen password securely.
        </div>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" class="container" style="max-width: 640px;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" class="card" style="background:#0F1E5D;color:#C9D3FF;border:0;border-radius:0;box-shadow:none;padding:24px;">
                      <tr>
                        <td align="left" style="padding-bottom:16px;">
                          <img src="http://cdn.mcauto-images-production.sendgrid.net/fe2f293446641ea1/9d2d6663-bd5f-4b91-8bf2-5704f37cbc78/3163x752.png" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                          Reset your alphaScreen password
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:20px;">
                          Use the button below to set a new password for your account.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom:18px;">
                          <a class="cta" href="${safeResetUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
                            Reset password
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:14px;line-height:1.55;padding-bottom:16px;">
                          If the button doesn’t work, <a href="${safeResetUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to reset your password.
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                          If you did not request this, you can safely ignore this email.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendSubscriptionCheckoutEmail(to, checkoutUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeCheckoutUrl = String(checkoutUrl || '').trim()
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Complete your alphaScreen membership',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Complete your alphaScreen membership</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
          @media (max-width: 640px) {
            .container { width: 100% !important; padding: 16px !important; }
            .card { padding: 18px !important; border-radius: 14px !important; }
            .cta { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
          }
        </style>
      </head>
      <body>
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          Complete your secure membership checkout to activate your account.
        </div>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" class="container" style="max-width: 640px;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" class="card" style="background:#0F1E5D;color:#C9D3FF;border:0;border-radius:0;box-shadow:none;padding:24px;">
                      <tr>
                        <td align="left" style="padding-bottom:16px;">
                          <img src="http://cdn.mcauto-images-production.sendgrid.net/fe2f293446641ea1/9d2d6663-bd5f-4b91-8bf2-5704f37cbc78/3163x752.png" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                          Complete your alphaScreen membership
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:12px;">
                          ${greeting}
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:20px;">
                          Your membership setup is almost complete. Use the button below to finish secure checkout and activate your account.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom:18px;">
                          <a class="cta" href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
                            Complete membership checkout
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:14px;line-height:1.55;padding-bottom:16px;">
                          If the button doesn’t work, <a href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to complete your membership checkout.
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                          Need help? Email <a href="mailto:info@alphasourceai.com" style="color:#A78BFA;">info@alphasourceai.com</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendRoleInterviewLimitReachedEmail(to, billingUrl, recipientName, roleTitle) {
  if (!API_KEY) return { skipped: true }
  const safeBillingUrl = String(billingUrl || '').trim()
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const safeRoleTitle = String(roleTitle || 'This role').trim() || 'This role'
  const msg = {
    to,
    from: FROM,
    subject: `${safeRoleTitle} has no interviews remaining`,
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Interview capacity required</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
          @media (max-width: 640px) {
            .container { width: 100% !important; padding: 16px !important; }
            .card { padding: 18px !important; border-radius: 14px !important; }
            .cta { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
          }
        </style>
      </head>
      <body>
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          A role has reached zero remaining interview capacity.
        </div>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" class="container" style="max-width: 640px;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" class="card" style="background:#0F1E5D;color:#C9D3FF;border:0;border-radius:0;box-shadow:none;padding:24px;">
                      <tr>
                        <td align="left" style="padding-bottom:16px;">
                          <img src="http://cdn.mcauto-images-production.sendgrid.net/fe2f293446641ea1/9d2d6663-bd5f-4b91-8bf2-5704f37cbc78/3163x752.png" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                          Interview capacity required
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:12px;">
                          ${greeting}
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:12px;">
                          <strong>${safeRoleTitle}</strong> has no interviews remaining.
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:20px;">
                          Additional interview capacity is required before new interviews can start.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom:18px;">
                          <a class="cta" href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
                            Open billing
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:14px;line-height:1.55;padding-bottom:16px;">
                          If the button doesn’t work, <a href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to open billing.
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                          Need help? Email <a href="mailto:info@alphasourceai.com" style="color:#A78BFA;">info@alphasourceai.com</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

module.exports = { sendInvite, sendPasswordResetEmail, sendSubscriptionCheckoutEmail, sendRoleInterviewLimitReachedEmail }
