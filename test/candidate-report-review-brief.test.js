'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateReportPayload: build, score } = require('../utils/candidateReportData');
const { buildCandidateReportHtml: html, candidateReportPdfOptions, getCandidateReportPdfOptions } = require('../utils/renderCandidateReport');
const fixture = () => ({
  candidate: { name:'Example Person', analysis_summary: { resume_score:86, experience_match_percent:88, skills_match_percent:90, education_match_percent:75, summary:'Current resume summary' } },
  role: { title:'Account Executive' }, client:{ name:'Fictional Company' }, exposeAdvanced:true,
  interview: { id:'current-attempt', attempt_number:2, status:'completed', created_at:'2026-10-09T16:00:00Z',
    transcript_scores:{ overall:82, confidence:78, ai_aided_risk:'low', ai_aided_risk_reason:'Specific examples provided.' },
    perception_scores:{ clarity:86, confidence:79, engagement:82 }, interview_summary:'Current interview summary',
    unanswered_candidate_questions:['Clarify the outcome.'], interview_analysis_v2:{
      scores:{ response_specificity:84, answer_directness:86, answer_consistency:82, communication_structure:80 },
      conditions:{ evaluation_conditions:'standard', signal_confidence:'moderate', audio_quality_issues:'none_indicated', distraction_risk:'low' },
      risk:{ integrity_risk:'low', reason:'Concrete examples support the responses.' }, evidence_summary:'Evidence summary', evidence:['A specific example'], limitations:['Self-reported outcomes'] },
  },
});
test('Report: 0 and 1 are scores, not missing data or ratio percentages', () => {
  for (const v of [0,'0',1,'1']) assert.equal(score(v), Number(v));
  for (const v of [null, undefined, '', ' ', false, [], {}, 'NaN','80%','85 garbage']) assert.equal(score(v), null);
});
test('Report: exact canonical attempt scores, summaries and all advanced data are preserved', () => {
  const input=fixture(), result=build(input);
  assert.equal(result.overall_score,84); assert.equal(result.interview_id,'current-attempt');
  assert.equal(result.interview_summary,'Current interview summary');
  assert.deepEqual(result.interview_analysis_v2.scores,input.interview.interview_analysis_v2.scores);
  assert.equal(result.interview_breakdown.evidence_strength,78);
  assert.deepEqual(result.unanswered_candidate_questions,['Clarify the outcome.']);
  assert.equal(result.status,'Scored');
});
test('Report: absent canonical sources never borrow cached report scores', () => {
  const result=build({ candidate:{ analysis_summary:{} }, report:{ resume_score:100, interview_score:100, overall_score:100, analysis:{ summary:'STALE' } } });
  assert.equal(result.resume_score,null); assert.equal(result.interview_score,null); assert.equal(result.overall_score,null);
  assert.equal(result.status,'Not started'); assert.doesNotMatch(html(result),/STALE/);
});
test('Report: feature gate cannot expose v2 even if stored on the attempt', () => {
  const input=fixture(); input.exposeAdvanced=false;
  assert.equal(build(input).interview_analysis_v2.evidence.length,0);
  assert.equal(build(input).interview_analysis_v2.scores.answer_directness,null);
  assert.doesNotMatch(html(build(input)),/Advanced interview analysis|class="evidence-page"|Integrity risk context/);
});
test('Report: overall uses canonical precision before display rounding', () => {
  const input=fixture(); input.candidate.analysis_summary.resume_score=85.6; input.interview.transcript_scores.overall=82.6;
  const result=build(input); assert.equal(result.overall_score,84); assert.equal(result.resume_score,85.6);
});
test('Report: headers carry only safe stable resource references', () => {
  const result=getCandidateReportPdfOptions({ candidate_id:'d38ade00-2026-4000-8000-000000001001', interview_id:'<script>evil</script>' });
  assert.match(result.headerTemplate,/d38ade00-2026-4000-8000-000000001001/);
  assert.doesNotMatch(result.headerTemplate,/<script>|evil/); assert.match(result.headerTemplate,/Unavailable/);
});
test('Report: no substantive response suppresses scores, signals and advanced evidence', () => {
  const input=fixture(); input.interview.has_substantive_response=false;
  input.interview.failure_code='NO_SUBSTANTIVE_CANDIDATE_RESPONSE';
  const result=build(input);
  assert.equal(result.interview_score,null); assert.equal(result.overall_score,null);
  assert.equal(result.interview_breakdown.clarity,null); assert.equal(result.interview_breakdown.evidence_strength,null);
  assert.equal(result.interview_breakdown.ai_aided_risk,''); assert.deepEqual(result.interview_analysis_v2.evidence,[]);
  assert.equal(result.status,'No response');
});
test('Report: text interviews retain transcript analysis but no perception/reliability', () => {
  const input=fixture(); input.interview.perception_scores={ mode:'text', unavailable:true, clarity:99 };
  const result=build(input);
  assert.equal(result.interview_score,82); assert.equal(result.interview_breakdown.clarity,null);
  assert.equal(result.interview_breakdown.evidence_strength,null);
  assert.equal(result.reliability_note,'Not applicable for text interviews.');
  assert.equal(result.interview_analysis_v2.scores.response_specificity,84);
});
test('Report: technical failures suppress perception and advanced signals', () => {
  const input=fixture(); input.interview.failure_code='MEDIA_DISCONNECTED';
  const result=build(input); assert.equal(result.status,'Tech issue');
  assert.equal(result.interview_breakdown.engagement,null); assert.deepEqual(result.interview_analysis_v2.evidence,[]);
});
test('Report: no-response classifier and text mode cannot override suppression precedence', () => {
  const input=fixture(); input.interview.conversation_progress_state='NoSubstantiveCandidateResponse'; input.interview.perception_scores.mode='text';
  const result=build(input); assert.equal(result.status,'No response'); assert.equal(result.interview_score,null);
  assert.equal(result.interview_breakdown.evidence_strength,null); assert.equal(result.interview_breakdown.ai_aided_risk,'');
  assert.equal(result.reliability_note,'Insufficient usable interview evidence.'); assert.deepEqual(result.interview_analysis_v2.evidence,[]);
});
test('Report: synthetic perception requires server-verified demo identity', () => {
  const input=fixture(); input.interview.perception_scores={ unavailable:true, mode:'demo', synthetic:true, clarity:77 };
  assert.equal(build(input).interview_breakdown.clarity,null);
  input.syntheticDemo=true; assert.equal(build(input).interview_breakdown.clarity,77);
  assert.match(html(build(input)),/SYNTHETIC DEMO/);
});
test('Report: HTML escaped in all content and prohibited v2 trait inference suppressed', () => {
  const input=fixture(); input.candidate.name='<script>fetch("https://example.com")</script>';
  input.interview.interview_analysis_v2.evidence.push('<img src="https://example.com">','Personality inference');
  const output=html(build(input)); assert.doesNotMatch(output,/<script>|<img src="https:\/\/example.com"|Personality inference/);
  assert.match(output,/&lt;script&gt;/); assert.match(output,/&lt;img/);
});
test('Report: long text not sliced and PDF uses report-only landscape settings', () => {
  const input=fixture(); input.interview.interview_analysis_v2.evidence=['Long evidence. '.repeat(800)+'FINAL_SENTINEL'];
  assert.match(html(build(input)),/FINAL_SENTINEL/); assert.equal(candidateReportPdfOptions.landscape,true);
  assert.match(candidateReportPdfOptions.footerTemplate,/totalPages/);
});
module.exports={ fixture };
test('Report: diagnostic phrases in a summary cannot suppress canonical completed scores', () => {
  for (const phrase of ['insufficient data','before any substantive responses were recorded','before substantive responses were captured']) {
    const input=fixture(); input.interview.interview_summary='The example discussed '+phrase+' in a previous project.';
    const result=build(input); assert.equal(result.interview_score,82); assert.equal(result.overall_score,84); assert.equal(result.status,'Scored');
    assert.equal(result.interview_breakdown.clarity,86); assert.equal(result.interview_analysis_v2.scores.answer_directness,86);
  }
});
test('Report: unavailable video is not mislabeled as a text interview', () => {
  const input=fixture(); input.interview.perception_scores={ mode:'video', unavailable:true, clarity:99 };
  const result=build(input); assert.equal(result.interview_breakdown.clarity,null); assert.equal(result.interview_breakdown.evidence_strength,null);
  assert.equal(result.reliability_note,'Media-based signals are unavailable.'); assert.equal(result.interview_score,82);
});
test('Report: supplied conditions-only and risk-only advanced data remain visible on an open gate', () => {
  for (const value of [{ conditions:{ audio_quality_issues:'minor' } }, { risk:{ integrity_risk:'medium', reason:'Clarify the inconsistency.' } }]) {
    const input=fixture(); input.interview.interview_analysis_v2=value;
    const output=html(build(input)); assert.match(output,/class="evidence-page"/);
    assert.match(output,value.conditions ? /Minor/ : /Clarify the inconsistency/);
    input.exposeAdvanced=false; assert.doesNotMatch(html(build(input)),/class="evidence-page"/);
  }
});
