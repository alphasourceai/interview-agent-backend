module.exports = {
  BUCKETS: {
    KBS: process.env.SUPABASE_KBS_BUCKET || "kbs",
    TRANSCRIPTS: process.env.SUPABASE_TRANSCRIPTS_BUCKET || "transcripts",
    ANALYSIS: process.env.SUPABASE_ANALYSIS_BUCKET || "analysis",
    REPORTS: process.env.SUPABASE_REPORTS_BUCKET || "reports",
    RESUMES: process.env.SUPABASE_RESUMES_BUCKET || "resumes",
  },
};
