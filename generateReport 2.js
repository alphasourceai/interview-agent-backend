const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function generateReport(candidate, analysis) {
  const timestamp = Date.now();
  const filename = `${candidate.email}-report-${timestamp}.pdf`;
  const filePath = path.join(__dirname, 'reports', filename);

  // Ensure /reports directory exists
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });

  const html = `
  <html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; padding: 40px; }
      h1 { color: #00cfc8; }
      .section { margin-bottom: 30px; }
      .score { font-size: 24px; margin: 10px 0; }
    </style>
  </head>
  <body>
    <h1>Candidate Report</h1>
    <div class="section">
      <strong>Name:</strong> ${candidate.name}<br>
      <strong>Email:</strong> ${candidate.email}<br>
      <strong>Date:</strong> ${new Date().toLocaleDateString()}
    </div>
    <div class="section">
      <h2>Resume Analysis</h2>
      <div class="score">Resume Score: ${analysis.resume_score}</div>
      <ul>
        <li>Skills Match: ${analysis.skills_match_percent}%</li>
        <li>Experience Match: ${analysis.experience_match_percent}%</li>
        <li>Education Match: ${analysis.education_match_percent}%</li>
        <li>Overall Resume Match: ${analysis.overall_resume_match_percent}%</li>
      </ul>
      <p><strong>Summary:</strong><br>${analysis.summary}</p>
    </div>
  </body>
  </html>
  `;

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: filePath, format: 'A4' });
  await browser.close();

  // Upload to Supabase
  const pdfBuffer = fs.readFileSync(filePath);
  const { error: uploadError } = await supabase.storage
    .from('reports')
    .upload(filename, pdfBuffer, {
      contentType: 'application/pdf'
    });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  // Get public URL
  const { data: publicURL } = supabase.storage
    .from('reports')
    .getPublicUrl(filename);

  // Clean up local file
  fs.unlinkSync(filePath);

  return publicURL.publicUrl;
}

module.exports = generateReport;
