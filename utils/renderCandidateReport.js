const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatePath = path.join(__dirname, '..', 'templates', 'pdf', 'candidate-report.hbs');
const templateSrc = fs.readFileSync(templatePath, 'utf8');
const template = Handlebars.compile(templateSrc);

// Optional helpers (if you want)
Handlebars.registerHelper('fallback', (v, d) => (v == null || v === '' ? d : v));

function buildCandidateReportHtml(payload) {
  const renderData = {
    name: payload.name,
    email: payload.email,
    status: payload.status,
    resume_score: payload.resume_score,
    interview_score: payload.interview_score,
    overall_score: payload.overall_score,
    resume_breakdown: payload.analysis?.resume?.scores || {},
    interview_breakdown: payload.analysis?.interview?.scores || {},
    resume_summary: payload.analysis?.resume?.summary || '',
    interview_summary: payload.analysis?.interview?.summary || '',
    unanswered_candidate_questions: payload.unanswered_candidate_questions || []
  };
  return template(renderData);
}

module.exports = { buildCandidateReportHtml };
