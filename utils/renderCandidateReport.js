const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { score, advanced } = require('./candidateReportData');

const templatePath = path.join(__dirname, '..', 'templates', 'pdf', 'candidate-report.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);

const LOGO_FILENAME = 'alphascreen-mark-08-navy.svg';

let cachedLogoSrc = null;
let triedLogoLoad = false;

Handlebars.registerHelper('fallback', (v, d) => (v == null || v === '' ? d : v));
Handlebars.registerHelper('hasScore', (v) => coerceNumber(v) !== null);
Handlebars.registerHelper('scoreText', (v) => {
  const n = coerceNumber(v);
  if (n === null) return '—';
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
});
Handlebars.registerHelper('scoreBarWidth', (v) => {
  const n = coerceNumber(v);
  if (n === null) return '';
  return String(Math.max(0, Math.min(100, Math.round(n))));
});

function coerceNumber(val) {
  return score(val);
}

const fontDir = path.join(__dirname, '../templates/email-attachments/alphascreen-getting-started-playbook-source/fonts');
const fontCss = [['Regular',400], ['SemiBold',600], ['Bold',700]].map(([name, weight]) =>
  `@font-face{font-family:Raleway;font-weight:${weight};src:url(data:font/ttf;base64,${fs.readFileSync(path.join(fontDir, 'Raleway-' + name + '.ttf')).toString('base64')}) format('truetype');}`
).join('');
function enumLabel(value) {
  return nonEmptyString(value).replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()) || 'Not assessed';
}
const candidateReportPdfOptions = Object.freeze({
  landscape: true, margin: { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' },
  displayHeaderFooter: true,
  footerTemplate: '<div style="font-family:Arial;font-size:8px;color:#66718a;width:100%;padding:0 10mm;display:flex;justify-content:space-between"><span>alphaScreen · Decision support, not a hiring decision.</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
});
function getCandidateReportPdfOptions(payload = {}) {
  const uuid = value => /^[0-9a-f-]{36}$/i.test(String(value || '')) ? String(value) : 'Unavailable';
  return { ...candidateReportPdfOptions,
    headerTemplate: '<div style="font-family:Arial;font-size:7px;color:#66718a;padding:0 10mm;width:100%">Candidate reference: ' + uuid(payload.candidate_id) + ' · Interview reference: ' + uuid(payload.interview_id) + '</div>',
  };
}

function nonEmptyString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    return t || '';
  }
  return String(value).trim();
}

function safeParseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function normalizeBreakdown(input) {
  const obj = (input && typeof input === 'object') ? input : {};
  const src = (obj.scores && typeof obj.scores === 'object') ? obj.scores : obj;

  return {
    experience: coerceNumber(src.experience),
    skills: coerceNumber(src.skills),
    education: coerceNumber(src.education),

    confidence: coerceNumber(src.confidence),
    clarity: coerceNumber(src.clarity),
    engagement: coerceNumber(src.engagement),
    evidence_strength: coerceNumber(src.evidence_strength),
    ai_aided_risk: nonEmptyString(src.ai_aided_risk),
    ai_aided_risk_reason: nonEmptyString(src.ai_aided_risk_reason),

    summary: nonEmptyString(obj.summary || src.summary)
  };
}

function normalizeQuestions(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((q) => (q == null ? '' : String(q).trim())).filter(Boolean);
  }
  if (typeof value === 'string') {
    const parsed = safeParseJsonMaybe(value);
    if (Array.isArray(parsed)) {
      return parsed.map((q) => (q == null ? '' : String(q).trim())).filter(Boolean);
    }
    return value
      .split(/\r?\n/)
      .map((q) => q.trim())
      .filter(Boolean);
  }
  return [];
}

function readLogoAsDataUri() {
  if (/^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(process.env.PDF_LOGO_DATA_URI || '')) return String(process.env.PDF_LOGO_DATA_URI);
  if (triedLogoLoad) return cachedLogoSrc || '';
  triedLogoLoad = true;

  const candidates = [
    path.join(__dirname, '..', 'templates', 'pdf', 'assets', LOGO_FILENAME),
  ];

  for (const logoPath of candidates) {
    try {
      if (fs.existsSync(logoPath)) {
        const base64 = fs.readFileSync(logoPath).toString('base64');
        cachedLogoSrc = `data:image/svg+xml;base64,${base64}`;
        return cachedLogoSrc;
      }
    } catch (_) {}
  }

  cachedLogoSrc = '';
  return '';
}

function buildCandidateReportHtml(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};

  const analysisObj =
    (p.analysis && typeof p.analysis === 'object')
      ? p.analysis
      : (safeParseJsonMaybe(p.analysis) || {});

  const resumeBreakdown = normalizeBreakdown(
    p.resume_breakdown ||
    p.resumeBreakdown ||
    analysisObj.resume ||
    analysisObj.resume_breakdown
  );

  const interviewBreakdown = normalizeBreakdown(
    p.interview_breakdown ||
    p.interviewBreakdown ||
    analysisObj.interview ||
    analysisObj.interview_breakdown
  );

  const analysisSummary = nonEmptyString(
    analysisObj.summary ||
    p.analysis_summary ||
    p.interview_summary ||
    interviewBreakdown.summary
  );

  const resumeSummary = nonEmptyString(
    p.resume_summary ||
    analysisObj?.resume?.summary ||
    resumeBreakdown.summary
  );

  const interviewSummary = nonEmptyString(
    p.interview_summary ||
    analysisObj?.interview?.summary ||
    interviewBreakdown.summary ||
    analysisSummary
  );

  const renderData = {
    font_css: fontCss,
    advanced: advanced(p.interview_analysis_v2),
    synthetic_demo: p.synthetic_demo === true,
    reliability_note: nonEmptyString(p.reliability_note),
    date_label: p.created_at && Number.isFinite(Date.parse(p.created_at)) ? new Date(p.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'Date unavailable',
    attempt_label: Number.isInteger(Number(p.attempt_number)) && Number(p.attempt_number) > 0 ? 'Attempt ' + Number(p.attempt_number) : 'Attempt unavailable',
    name: nonEmptyString(p.name),
    email: nonEmptyString(p.email),
    company_name: nonEmptyString(p.company_name ?? p.client_name),
    role_name: nonEmptyString(p.role_name),
    status: nonEmptyString(p.status),

    resume_score: coerceNumber(p.resume_score) ?? coerceNumber(p.resumeScore) ?? null,
    interview_score: coerceNumber(p.interview_score) ?? coerceNumber(p.interviewScore) ?? null,
    overall_score: coerceNumber(p.overall_score) ?? coerceNumber(p.overallScore) ?? null,

    resume_breakdown: resumeBreakdown,
    interview_breakdown: interviewBreakdown,

    resume_summary: resumeSummary,
    interview_summary: interviewSummary,

    analysis: { summary: analysisSummary },

    unanswered_candidate_questions: normalizeQuestions(
      p.unanswered_candidate_questions ?? p.unansweredCandidateQuestions
    ),

    logo_src: readLogoAsDataUri()
  };

  renderData.resume_rows = ['experience', 'skills', 'education'].map(key => ({ label: enumLabel(key), score: resumeBreakdown[key], color: '#03ACDF' }));
  renderData.interview_rows = ['clarity', 'confidence', 'engagement'].map(key => ({ label: enumLabel(key), score: interviewBreakdown[key], color: '#A37FF5' }));
  renderData.advanced_rows = ['response_specificity', 'answer_directness', 'answer_consistency', 'communication_structure'].map((key, i) => ({ label: enumLabel(key), score: renderData.advanced.scores[key], color: ['#03ACDF','#A37FF5','#00BB88','#EDA311'][i] }));
  renderData.has_advanced = Object.values(renderData.advanced.scores).some(value => value !== null) || !!renderData.advanced.evidence_summary || renderData.advanced.evidence.length > 0 || renderData.advanced.limitations.length > 0 || Object.values(renderData.advanced.conditions).some(Boolean) || Object.values(renderData.advanced.risk).some(Boolean);
  renderData.badges = ['evaluation_conditions', 'signal_confidence', 'audio_quality_issues', 'distraction_risk'].filter(key => renderData.advanced.conditions[key]).map(key => ({ label: enumLabel(key), value: enumLabel(renderData.advanced.conditions[key]) }));
  if (renderData.advanced.risk.integrity_risk) renderData.badges.push({ label: 'Integrity risk', value: enumLabel(renderData.advanced.risk.integrity_risk) });
  renderData.risk_label = enumLabel(interviewBreakdown.ai_aided_risk);

  return template(renderData);
}

module.exports = { buildCandidateReportHtml, candidateReportPdfOptions, getCandidateReportPdfOptions };
