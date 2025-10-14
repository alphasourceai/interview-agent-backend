const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatePath = path.join(__dirname, '..', 'templates', 'pdf', 'candidate-report.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);

// Optional helpers (if you want)
Handlebars.registerHelper('fallback', (v, d) => (v == null || v === '' ? d : v));

function buildCandidateReportHtml(payload) {
  // Expecting payload fields used by the template:
  // { name, email, status, resume_score, interview_score, overall_score,
  //   resume_breakdown: { experience, skills, education, summary? },
  //   interview_breakdown: { confidence, clarity, body_language },
  //   analysis? }
  return template(payload);
}

module.exports = { buildCandidateReportHtml };