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
const BRAND_LOGO_URL = process.env.BRANDED_EMAIL_LOGO_URL || 'https://rytlclkkcvvnkoncfaid.supabase.co/storage/v1/object/public/email-assets/Color%20logo%20-%20no%20background.png'
const DEFAULT_HELP_EMAIL = process.env.BRANDED_EMAIL_HELP_EMAIL || 'info@alphasourceai.com'

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeLegacyContentStyles(value) {
  return String(value || '')
    .replace(/#A78BFA/gi, '#A380F6')
    .replace(/#CFCBFF/gi, '#D7CBFB')
    .replace(/#C9D3FF/gi, '#46527C')
    .replace(/#E6EBFF/gi, '#0A1547')
    .replace(/#9FB0FF/gi, '#5C6A98')
    .replace(/#6B77C9/gi, '#6A76A2')
    .replace(/#FFFFFF/gi, '#4E40A5')
    .replace(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.10\s*\)/gi, 'rgba(10,21,71,0.12)')
}

function formatTimestampAsCst(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(parsed)
  const partValue = (type) => parts.find((part) => part.type === type)?.value || ''
  const month = partValue('month')
  const day = partValue('day')
  const year = partValue('year')
  const hour24 = Number(partValue('hour'))
  const minute = partValue('minute')
  if (!month || !day || !year || !Number.isFinite(hour24) || !minute) return raw
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${month}-${day}-${year} ${String(hour12).padStart(2, '0')}:${minute} CST`
}

function buildBrandedEmailShell({
  title,
  preheader = '',
  contentHtml = '',
  helpEmail = DEFAULT_HELP_EMAIL,
  footerNote = ''
} = {}) {
  const safeTitle = escapeHtml(title || '')
  const safePreheader = escapeHtml(preheader || '')
  const safeLogoUrl = escapeHtml(BRAND_LOGO_URL)
  const normalizedContentHtml = normalizeLegacyContentStyles(contentHtml || '')
  const safeHelpEmail = String(helpEmail || '').trim()
  const safeFooterNote = String(footerNote || '').trim()
  const footerParts = []
  if (safeHelpEmail) {
    const safeHelp = escapeHtml(safeHelpEmail)
    footerParts.push(`Need help? Email <a href="mailto:${safeHelp}" style="color:#A380F6;font-weight:700;">${safeHelp}</a>`)
  }
  if (safeFooterNote) footerParts.push(escapeHtml(safeFooterNote))
  const footerHtml = footerParts.length
    ? `
      <tr>
        <td style="border-top:1px solid rgba(10,21,71,0.12);padding-top:14px;color:#6A76A2;font-size:13px;line-height:1.55;">
          ${footerParts.map((part, index) => `<div style="${index > 0 ? 'margin-top:8px;' : ''}">${part}</div>`).join('')}
        </td>
      </tr>
    `
    : ''
  return `
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="light" />
      <meta name="supported-color-schemes" content="light" />
      <title>${safeTitle}</title>
      <style>
        body { margin: 0; padding: 0; background: #F8F9FD; color: #0A1547; font-family: Raleway, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        table { border-collapse: collapse; }
        a { color: #4E40A5; text-decoration: none; }
        p { margin: 0 0 12px; color: #0A1547; font-size: 15px; line-height: 1.65; }
        ul { margin: 0 0 12px; padding: 0; }
        li { color: #46527C; font-size: 14px; line-height: 1.55; }
        .cta {
          display: inline-block;
          background: #A380F6;
          color: #FFFFFF !important;
          border: 1px solid #8E6EE0;
          border-radius: 12px;
          padding: 11px 18px;
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
        }
        @media (max-width: 640px) {
          .container { width: 100% !important; padding: 16px !important; }
          .card { padding: 18px !important; }
          .cta { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
        }
      </style>
    </head>
    <body>
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${safePreheader}
      </div>
      <table role="presentation" width="100%" style="background:#F8F9FD;color:#33416D;">
        <tr>
          <td align="center" style="padding: 24px 16px;">
            <table role="presentation" width="100%" class="container" style="max-width: 640px;">
              <tr>
                <td>
                  <table role="presentation" width="100%" class="card" style="background:#F8F9FD;color:#0A1547;border:0;border-radius:0;box-shadow:none;padding:24px;">
                    <tr>
                      <td align="left" style="padding-bottom:16px;">
                        <img src="${safeLogoUrl}" alt="AlphaSource" width="208" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;" />
                      </td>
                    </tr>
                    <tr>
                      <td style="color:#0A1547;font-size:24px;line-height:1.25;font-weight:700;padding-bottom:10px;">
                        ${safeTitle}
                      </td>
                    </tr>
                    <tr>
                      <td style="color:#0A1547;">
                        ${normalizedContentHtml}
                      </td>
                    </tr>
                    ${footerHtml}
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

async function sendInvite(to, acceptUrl, inviterEmail) {
  if (!API_KEY) return { skipped: true }
  const safeAcceptUrl = escapeHtml(String(acceptUrl || '').trim())
  const safeInviterEmail = escapeHtml(inviterEmail || '')
  const msg = {
    to,
    from: FROM,
    subject: 'You’ve been invited to Interview Agent',
    html: buildBrandedEmailShell({
      title: 'You’re invited to Interview Agent',
      preheader: 'Accept your invite to join your client account.',
      contentHtml: `
        <p style="margin:0 0 12px;color:#C9D3FF;font-size:15px;line-height:1.6;">
          You’ve been invited to join a client account on Interview Agent.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeAcceptUrl}" target="_blank" rel="noopener noreferrer">
            Accept your invite
          </a>
        </p>
        ${safeInviterEmail ? `<p style="margin:0 0 12px;color:#C9D3FF;font-size:14px;line-height:1.55;">Invited by: <strong>${safeInviterEmail}</strong></p>` : ''}
        <p style="margin:0 0 16px;color:#C9D3FF;font-size:14px;line-height:1.55;">
          This link will sign you in and associate your account with the correct client.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendSubscriptionCheckoutEmail(to, checkoutUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeCheckoutUrl = escapeHtml(String(checkoutUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Complete your alphaScreen membership',
    html: buildBrandedEmailShell({
      title: 'Complete your alphaScreen membership',
      preheader: 'Complete your secure membership checkout to activate your account.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Your membership setup is almost complete. Use the button below to finish secure checkout and activate your account.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer">
            Complete membership checkout
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeCheckoutUrl}" target="_blank" rel="noopener noreferrer">click here</a> to complete your membership checkout.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendRoleInterviewLimitReachedEmail(to, billingUrl, recipientName, roleTitle) {
  if (!API_KEY) return { skipped: true }
  const safeBillingUrl = escapeHtml(String(billingUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const roleTitleText = String(roleTitle || 'This role').trim() || 'This role'
  const safeRoleTitle = escapeHtml(roleTitleText)
  const msg = {
    to,
    from: FROM,
    subject: `${roleTitleText} has no interviews remaining`,
    html: buildBrandedEmailShell({
      title: 'Interview capacity required',
      preheader: 'A role has reached zero remaining interview capacity.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          <strong>${safeRoleTitle}</strong> has no interviews remaining.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Additional interview capacity is required before new interviews can start.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer">
            Open billing
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeBillingUrl}" target="_blank" rel="noopener noreferrer">click here</a> to open billing.
        </p>
      `
    }),
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMemberRecoveryEmail(to, recoveryUrl, recipientName) {
  if (!API_KEY) return { skipped: true }
  const safeRecoveryUrl = escapeHtml(String(recoveryUrl || '').trim())
  const firstNameRaw = String(recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const safeFirstName = firstNameRaw.replace(/[^A-Za-z0-9'.-]/g, '').slice(0, 40)
  const greeting = /[A-Za-z0-9]/.test(safeFirstName) ? `Hi ${safeFirstName},` : 'Hi there,'
  const msg = {
    to,
    from: FROM,
    subject: 'Set or reset your alphaScreen password',
    html: buildBrandedEmailShell({
      title: 'Set or reset your password',
      preheader: 'Use this secure link to set or reset your account password.',
      helpEmail: 'info@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">
          Use the secure link below to finish account setup and access your dashboard.
        </p>
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer">
            Set password
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeRecoveryUrl}" target="_blank" rel="noopener noreferrer">click here</a> to set your password.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementEmail(to, signingUrl, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeSigningUrl = escapeHtml(String(signingUrl || '').trim())
  const clientLegalNameText = String(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safeClientLegalName = escapeHtml(details.clientLegalName || details.client_legal_name || 'Your organization')
  const safePrimaryAdmin = escapeHtml(details.primaryAdmin || details.primary_admin_name || '')
  const safeMembershipTier = escapeHtml(details.membershipTier || details.membership_tier || '')
  const formattedExpiresOn = formatTimestampAsCst(details.expiresOn || details.expires_on || '')
  const safeExpiresOn = escapeHtml(formattedExpiresOn)
  const greeting = safePrimaryAdmin ? `Hi ${safePrimaryAdmin},` : 'Hi there,'

  const msg = {
    to,
    from: FROM,
    subject: 'Review and sign your alphaScreen Membership Agreement',
    html: buildBrandedEmailShell({
      title: 'alphaScreen Membership Agreement',
      preheader: `Your membership agreement for ${clientLegalNameText} is ready for signature.`,
      helpEmail: 'memberships@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          ${escapeHtml(greeting)}
        </p>
        <p style="margin:0 0 10px;font-size:15px;line-height:1.6;">
          Your membership agreement for <strong>${safeClientLegalName}</strong> is ready for signature.
        </p>
        ${safeMembershipTier ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;">Membership tier: <strong>${safeMembershipTier}</strong></p>` : ''}
        ${safeExpiresOn ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">Signing link expires on: <strong>${safeExpiresOn}</strong></p>` : ''}
        <p style="margin:0 0 18px;">
          <a class="cta" href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer">
            Review and sign agreement
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.55;">
          If the button doesn’t work, <a href="${safeSigningUrl}" target="_blank" rel="noopener noreferrer">click here</a> to open the agreement.
        </p>
      `
    })
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
    subject: 'Membership agreement sent - client checkout follows signature',
    html: buildBrandedEmailShell({
      title: 'Membership agreement sent',
      preheader: 'Membership agreement sent - client continues to checkout after signature.',
      helpEmail: '',
      footerNote: 'Internal notification for the memberships workflow.',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          A membership agreement has been sent.
        </p>
        <ul style="margin:0 0 14px;padding:0;">
          ${detailItems || '<li style="margin:0 0 6px 18px;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
        </ul>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.55;">
          After signing, the client can continue directly to checkout from the signature flow.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

async function sendMembershipAgreementSignedCopyEmail(to, details = {}) {
  if (!API_KEY) return { skipped: true }
  const safeExecutedPdfUrl = escapeHtml(String(details.executedPdfUrl || details.executed_pdf_url || '').trim())
  const clientLegalNameText = String(details.clientLegalName || details.client_legal_name || 'Your organization')
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
    html: buildBrandedEmailShell({
      title: 'Signed Membership Agreement',
      preheader: `Your signed agreement for ${clientLegalNameText} is attached.`,
      helpEmail: 'memberships@alphasourceai.com',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          ${escapeHtml(greeting)}
        </p>
        <p style="margin:0 0 10px;font-size:15px;line-height:1.6;">
          Your signed agreement for <strong>${safeClientLegalName}</strong> is attached.
        </p>
        ${safeSignerTypedName ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;">Signed by: <strong>${safeSignerTypedName}</strong></p>` : ''}
        ${safeSignedAt ? `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">Signed at: <strong>${safeSignedAt}</strong></p>` : ''}
        ${safeExecutedPdfUrl ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.55;">Secure copy link: <a href="${safeExecutedPdfUrl}" target="_blank" rel="noopener noreferrer">Open signed agreement</a></p>` : ''}
      `
    })
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
    subject: 'Membership agreement signed - client checkout ready',
    html: buildBrandedEmailShell({
      title: 'Membership agreement signed',
      preheader: 'Membership agreement signed - client can continue to checkout from the signature success page.',
      helpEmail: '',
      footerNote: 'Internal notification for the memberships workflow.',
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
          A membership agreement has been signed.
        </p>
        <ul style="margin:0 0 14px;padding:0;">
          ${detailItems || '<li style="margin:0 0 6px 18px;font-size:13px;line-height:1.5;">No agreement details provided.</li>'}
        </ul>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.55;">
          The client can continue directly to checkout from the signature success page, and payment onboarding continues through the client checkout flow.
        </p>
      `
    })
  }
  const [resp] = await sg.send(msg)
  return { statusCode: resp?.statusCode || 0 }
}

module.exports = {
  escapeHtml,
  buildBrandedEmailShell,
  sendInvite,
  sendSubscriptionCheckoutEmail,
  sendRoleInterviewLimitReachedEmail,
  sendMemberRecoveryEmail,
  sendMembershipAgreementEmail,
  sendMembershipAgreementInternalNotification,
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification
}
