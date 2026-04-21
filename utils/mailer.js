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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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

async function sendMemberRecoveryEmail(to, recoveryUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeRecoveryUrl = String(recoveryUrl || '').trim()
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Set or reset your alphaScreen password',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Set or reset your alphaScreen password</title>
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
          Use this secure link to set or reset your account password.
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
                          <img src="https://rytlclkkcvvnkoncfaid.supabase.co/storage/v1/object/public/email-assets/Color%20logo%20-%20no%20background.png" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                          Set or reset your password
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:12px;">
                          ${greeting}
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:15px;line-height:1.6;padding-bottom:20px;">
                          Use the secure link below to finish account setup and access your dashboard.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom:18px;">
                          <a class="cta" href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
                            Set password
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#C9D3FF;font-size:14px;line-height:1.55;padding-bottom:16px;">
                          If the button doesn’t work, <a href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to set your password.
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
    `
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementEmail(to, signingUrl, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeSigningUrl = String(signingUrl || '').trim()
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeMembershipTier = escapeHtml(details.membershipTier || details.membership_tier || '')
  const safeExpiresOn = escapeHtml(details.expiresOn || details.expires_on || '')
  const greeting = safePrimaryAdmin ? `Hi ${safePrimaryAdmin},` : 'Hi there,'

  const msg = {
    to,
    from: FROM,
    subject: 'Review and sign your alphaScreen Membership Agreement',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Sign your alphaScreen Membership Agreement</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
        </style>
      </head>
      <body>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" style="max-width: 640px;">
                <tr>
                  <td style="background:#0F1E5D;color:#C9D3FF;padding:24px;">
                    <p style="margin:0 0 10px;color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;">
                      alphaScreen Membership Agreement
                    </p>
                    <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      ${greeting}
                    </p>
                    <p style="margin:0 0 10px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      Your membership agreement for <strong>${safeClientLegalName}</strong> is ready for signature.
                    </p>
                    ${safeMembershipTier ? `<p style="margin:0 0 10px;color:#C9D3FF;font-size:14px;line-height:1.55;">Membership tier: <strong>${safeMembershipTier}</strong></p>` : ''}
                    ${safeExpiresOn ? `<p style="margin:0 0 14px;color:#C9D3FF;font-size:14px;line-height:1.55;">Signing link expires on: <strong>${safeExpiresOn}</strong></p>` : ''}
                    <p style="margin:0 0 18px;">
                      <a href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#A78BFA;color:#0A1547;border:1px solid #CFCBFF;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;line-height:1;">
                        Review and sign agreement
                      </a>
                    </p>
                    <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
                      If the button doesn’t work, <a href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">click here</a> to open the agreement.
                    </p>
                    <p style="margin:0;border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                      Need help? Email <a href="mailto:memberships@alphasourceai.com" style="color:#A78BFA;">memberships@alphasourceai.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementInternalNotification(to, details = {}) {
  if (!API_KEY) return { skipped: true }

  const safeAgreementId = escapeHtml(details.agreementId || details.agreement_id || '')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || '')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeAdminEmail = escapeHtml(details.adminEmail || details.admin_email || '')
  const safeMembershipTier = escapeHtml(details.membershipTier || details.membership_tier || '')
  const safeBillingOption = escapeHtml(details.billingOption || details.billing_option || '')
  const detailItems = [
    safeAgreementId ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Agreement ID:</strong> ${safeAgreementId}</li>` : '',
    safeClientLegalName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Client:</strong> ${safeClientLegalName}</li>` : '',
    safePrimaryAdmin ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Primary Admin:</strong> ${safePrimaryAdmin}</li>` : '',
    safeAdminEmail ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Admin Email:</strong> ${safeAdminEmail}</li>` : '',
    safeMembershipTier ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Membership Tier:</strong> ${safeMembershipTier}</li>` : '',
    safeBillingOption ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Billing Option:</strong> ${safeBillingOption}</li>` : ''
  ].filter(Boolean).join('')

  const msg = {
    to,
    from: FROM,
    subject: 'Membership agreement sent - manual checkout follow-up required',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Membership agreement sent</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
        </style>
      </head>
      <body>
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          Membership agreement sent - manual checkout follow-up required.
        </div>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" style="max-width: 640px;">
                <tr>
                  <td style="background:#0F1E5D;color:#C9D3FF;padding:24px;">
                    <p style="margin:0 0 10px;color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;">
                      Membership agreement sent
                    </p>
                    <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      A membership agreement has been sent and requires manual checkout follow-up.
                    </p>
                    <ul style="margin:0 0 14px;padding:0;">
                      ${detailItems || '<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
                    </ul>
                    <p style="margin:0 0 14px;color:#C9D3FF;font-size:14px;line-height:1.55;">
                      After signature is complete, manually send checkout per current phase-1 process.
                    </p>
                    <p style="margin:0;border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                      Internal notification for the memberships workflow.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementSignedCopyEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeExecutedPdfUrl = String(details.executedPdfUrl || details.executed_pdf_url || '').trim()
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeSignerTypedName = escapeHtml(details.signerTypedName || details.signer_typed_name || '')
  const safeSignedAt = escapeHtml(details.signedAt || details.signed_at || '')
  const pdfBase64 = String(details.pdfBase64 || details.pdf_base64 || '').trim()
  const fileName = String(details.fileName || details.file_name || 'membership-agreement-signed.pdf').trim() || 'membership-agreement-signed.pdf'
  const greeting = safePrimaryAdmin ? `Hi ${safePrimaryAdmin},` : 'Hi there,'

  const msg = {
    to,
    from: FROM,
    subject: 'Your signed alphaScreen Membership Agreement',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Your signed alphaScreen Membership Agreement</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
        </style>
      </head>
      <body>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" style="max-width: 640px;">
                <tr>
                  <td style="background:#0F1E5D;color:#C9D3FF;padding:24px;">
                    <p style="margin:0 0 10px;color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;">
                      Signed Membership Agreement
                    </p>
                    <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      ${greeting}
                    </p>
                    <p style="margin:0 0 10px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      Your signed agreement for <strong>${safeClientLegalName}</strong> is attached.
                    </p>
                    ${safeSignerTypedName ? `<p style="margin:0 0 10px;color:#C9D3FF;font-size:14px;line-height:1.55;">Signed by: <strong>${safeSignerTypedName}</strong></p>` : ''}
                    ${safeSignedAt ? `<p style="margin:0 0 14px;color:#C9D3FF;font-size:14px;line-height:1.55;">Signed at: <strong>${safeSignedAt}</strong></p>` : ''}
                    ${safeExecutedPdfUrl ? `<p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">Secure copy link: <a href="${safeExecutedPdfUrl}" target="_blank" rel="noopener noreferrer" style="color:#FFFFFF;">Open signed agreement</a></p>` : ''}
                    <p style="margin:0;border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                      Need help? Email <a href="mailto:memberships@alphasourceai.com" style="color:#A78BFA;">memberships@alphasourceai.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  }

  if (pdfBase64) {
    msg.attachments = [
      {
        content: pdfBase64,
        type: 'application/pdf',
        filename: fileName,
        disposition: 'attachment'
      }
    ]
  }

  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementCompletedInternalNotification(to, details = {}) {
  if (!API_KEY) return { skipped: true }

  const safeAgreementId = escapeHtml(details.agreementId || details.agreement_id || '')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || '')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeAdminEmail = escapeHtml(details.adminEmail || details.admin_email || '')
  const safeSignerTypedName = escapeHtml(details.signerTypedName || details.signer_typed_name || '')
  const safeSignedAt = escapeHtml(details.signedAt || details.signed_at || '')
  const detailItems = [
    safeAgreementId ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Agreement ID:</strong> ${safeAgreementId}</li>` : '',
    safeClientLegalName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Client:</strong> ${safeClientLegalName}</li>` : '',
    safePrimaryAdmin ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Primary Admin:</strong> ${safePrimaryAdmin}</li>` : '',
    safeAdminEmail ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Admin Email:</strong> ${safeAdminEmail}</li>` : '',
    safeSignerTypedName ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Signer:</strong> ${safeSignerTypedName}</li>` : '',
    safeSignedAt ? `<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;"><strong>Signed At:</strong> ${safeSignedAt}</li>` : ''
  ].filter(Boolean).join('')

  const msg = {
    to,
    from: FROM,
    subject: 'Membership agreement signed - manual checkout follow-up required',
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>Membership agreement signed</title>
        <style>
          body { margin: 0; padding: 0; background: #0F1E5D; font-family: -apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
          table { border-collapse: collapse; }
          a { text-decoration: none; }
        </style>
      </head>
      <body>
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          Membership agreement signed - manual checkout follow-up required.
        </div>
        <table role="presentation" width="100%" style="background:#0F1E5D;color:#C9D3FF;">
          <tr>
            <td align="center" style="padding: 24px 16px;">
              <table role="presentation" width="100%" style="max-width: 640px;">
                <tr>
                  <td style="background:#0F1E5D;color:#C9D3FF;padding:24px;">
                    <p style="margin:0 0 10px;color:#E6EBFF;font-size:24px;line-height:1.25;font-weight:700;">
                      Membership agreement signed
                    </p>
                    <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
                      A membership agreement has been signed and is ready for manual checkout follow-up.
                    </p>
                    <ul style="margin:0 0 14px;padding:0;">
                      ${detailItems || '<li style="margin:0 0 6px 18px;color:#E6EBFF;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
                    </ul>
                    <p style="margin:0 0 14px;color:#C9D3FF;font-size:14px;line-height:1.55;">
                      Send checkout manually per current process.
                    </p>
                    <p style="margin:0;border-top:1px solid rgba(255,255,255,0.10);padding-top:14px;color:#6B77C9;font-size:13px;line-height:1.55;">
                      Internal notification for the memberships workflow.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

module.exports = {
  sendInvite,
  sendSubscriptionCheckoutEmail,
  sendRoleInterviewLimitReachedEmail,
  sendMemberRecoveryEmail,
  sendMembershipAgreementEmail,
  sendMembershipAgreementInternalNotification,
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification
}
