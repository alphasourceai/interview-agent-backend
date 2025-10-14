const router = require('express').Router();
const { htmlToPdf } = require('../utils/pdfRenderer');
const { buildCandidateReportHtml } = require('../utils/renderCandidateReport');

function extractData(body) {
  // Accept either { data: {...} } or raw {...}
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body || {};
}

// HTML preview for quick layout checks (no PDF)
// POST /api/reports/html-preview
router.post('/reports/html-preview', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[reports/html-preview] error:', err);
    return res.status(500).json({ error: 'HTML render failed' });
  }
});

router.post('/reports/preview-pdf', async (req, res) => {
  try {
    const data = extractData(req.body);
    const html = buildCandidateReportHtml(data);
    const pdf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="candidate-report.pdf"');
    return res.send(pdf);
  } catch (err) {
    console.error('[reports/preview-pdf] error:', err);
    res.status(500).json({ error: 'PDF render failed' });
  }
});

// Production endpoint (stubbed until Step 3)
// POST /api/reports/pdf
router.post('/reports/pdf', async (req, res) => {
  try {
    return res.status(501).json({ error: 'not_implemented', detail: 'PDF generation will be enabled after Step 3.' });
  } catch (err) {
    console.error('[reports/pdf] error:', err);
    return res.status(500).json({ error: 'PDF endpoint error' });
  }
});

module.exports = router;