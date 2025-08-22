# interview-agent-backend
## PDF Provider (External now, Internal later)

### Current (MVP): PDFMonkey (on-demand)
- Endpoint: `GET /reports/:interview_id/download`
  - Generates if needed and streams the PDF to the browser.
- Endpoint: `GET /reports/:interview_id/generate`
  - Returns a pre-signed URL from PDFMonkey (debug/preview).
- Env:
  - `PDFMONKEY_API_KEY`
  - `PDFMONKEY_TEMPLATE_ID` (UUID from the PDFMonkey Document Template)

Rationale:
- On-demand keeps costs down and avoids stale reports.
- Dashboard is source of truth; PDF is a snapshot when the client clicks “Download”.

### Planned: Internal HTML→PDF provider
Goal: eliminate external PDF spend while keeping identical layout.

Approach:
- Render branded HTML/CSS with the same data (scores, breakdowns, summary).
- Use Playwright (headless Chromium) to print to PDF on the backend.

Proposed files:
- `src/lib/reportTemplate.js` → `reportHTML(payload)` returns full HTML (inline CSS + SVG gauges).
- `src/lib/htmlToPdf.js` → `htmlToPdf(html) -> Buffer` using Playwright.

Feature flag:
- `PDF_PROVIDER=pdfmonkey|internal` (default `pdfmonkey`).
- `internal` path used by `/reports/:interview_id/download` will:
  1) build payload,
  2) HTML→PDF buffer,
  3) stream as attachment (`Content-Disposition`).

Deployment notes:
- Add to `package.json`: `"postinstall": "npx playwright install --with-deps chromium"`
- Set `PLAYWRIGHT_BROWSERS_PATH=0` in env for Render.
- Optional caching: compute a `fingerprint` of payload; if an identical PDF exists in a private `reports/` bucket, return a signed URL instead of regenerating.

Security:
- All report generation and storage is server-side with service-role keys.
- Clients only ever receive signed URLs or streamed PDFs.

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
PDFMONKEY_API_KEY=
PDFMONKEY_TEMPLATE_ID=
SENDGRID_API_KEY=
SENDGRID_FROM=no-reply@yourdomain.com
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173
SUPABASE_REPORTS_BUCKET=reports
SUPABASE_TRANSCRIPTS_BUCKET=transcripts
SUPABASE_ANALYSIS_BUCKET=analysis
SIGNED_URL_TTL_SECONDS=300
