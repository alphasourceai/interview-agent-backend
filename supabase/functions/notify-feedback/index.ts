const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SENDGRID_FROM_EMAIL = Deno.env.get('SENDGRID_FROM_EMAIL') ?? 'info@alphasourceai.com';
const RECIPIENTS = ['derek@alphasourceai.com', 'jason@alphasourceai.com'];
const JSON_HEADERS = { 'content-type': 'application/json' };

const toArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === null || value === undefined) return [];
  return [String(value)];
};

const safeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value);
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: JSON_HEADERS
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch (err) {
    console.error('[notify-feedback] invalid json payload', err?.message || err);
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: JSON_HEADERS
    });
  }

  if (!SENDGRID_API_KEY) {
    console.error('[notify-feedback] SENDGRID_API_KEY missing');
    return new Response(JSON.stringify({ error: 'sendgrid_not_configured' }), {
      status: 500,
      headers: JSON_HEADERS
    });
  }

  const lines: string[] = [];
  lines.push('New NDA Tester feedback submission');
  lines.push('');
  lines.push(`id: ${safeText(payload.id)}`);
  lines.push(`created_at: ${safeText(payload.created_at)}`);
  lines.push(`name: ${safeText(payload.name)}`);
  lines.push(`email: ${safeText(payload.email)}`);
  lines.push(`browser: ${safeText(payload.browser)}`);
  lines.push(`device_type: ${safeText(payload.device_type)}`);
  lines.push('');

  const issueIds = toArray(payload.selected_issue_ids);
  lines.push('selected_issue_ids:');
  if (issueIds.length) issueIds.forEach((id) => lines.push(`- ${id}`));
  else lines.push('- (none)');

  const newIssueText = safeText(payload.new_issue_text);
  if (newIssueText) {
    lines.push('new_issue_text:');
    lines.push(newIssueText);
  }

  lines.push('');
  const suggestionIds = toArray(payload.selected_suggestion_ids);
  lines.push('selected_suggestion_ids:');
  if (suggestionIds.length) suggestionIds.forEach((id) => lines.push(`- ${id}`));
  else lines.push('- (none)');

  const newSuggestionText = safeText(payload.new_suggestion_text);
  if (newSuggestionText) {
    lines.push('new_suggestion_text:');
    lines.push(newSuggestionText);
  }

  const screenshotUrls = toArray(payload.screenshot_urls);
  if (screenshotUrls.length) {
    lines.push('');
    lines.push('screenshot_urls:');
    screenshotUrls.forEach((url) => lines.push(url));
  }

  const emailPayload = {
    personalizations: [
      {
        to: RECIPIENTS.map((email) => ({ email }))
      }
    ],
    from: { email: SENDGRID_FROM_EMAIL },
    subject: 'New NDA Tester feedback submission',
    content: [
      {
        type: 'text/plain',
        value: lines.join('\n')
      }
    ]
  };

  try {
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SENDGRID_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[notify-feedback] SendGrid error', {
        status: resp.status,
        body: text
      });
      return new Response(
        JSON.stringify({
          error: 'sendgrid_failed',
          status: resp.status,
          detail: text
        }),
        { status: 500, headers: JSON_HEADERS }
      );
    }
  } catch (err) {
    console.error('[notify-feedback] SendGrid request failed', err?.message || err);
    return new Response(JSON.stringify({ error: 'sendgrid_request_failed' }), {
      status: 500,
      headers: JSON_HEADERS
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: JSON_HEADERS
  });
});
