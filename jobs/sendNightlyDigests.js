require('dotenv').config();
const { supabase } = require('../supabaseClient');
const sgMail = require('@sendgrid/mail');
const { format, startOfDay, endOfDay } = require('date-fns');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendNightlyDigests() {
  console.log('🚀 Nightly digest job started');

  try {
    const now = new Date();
    const timezoneOffset = -6 * 60; // CST offset in minutes
    const cstNow = new Date(now.getTime() + timezoneOffset * 60 * 1000);

    const start = new Date(cstNow);
    start.setHours(0, 0, 0, 0);

    const end = new Date(cstNow);
    end.setHours(23, 59, 59, 999);

    const { data: roles, error: rolesError } = await supabase
      .from('roles')
      .select('id, title, client_id, created_at');

    if (rolesError) throw new Error('Failed to fetch roles');
    console.log(`📌 Fetched ${roles.length} roles`);

    for (const role of roles) {
      const { data: clientData, error: clientError } = await supabase
        .from('clients')
        .select('email')
        .eq('id', role.client_id)
        .single();

      if (clientError || !clientData?.email) {
        console.log(`⚠️ Skipping role ${role.title} (missing client email)`);
        continue;
      }

      const { data: reports, error: reportsError } = await supabase
        .from('reports')
        .select('candidate_id, report_url, overall_score')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .eq('role_id', role.id);

      if (reportsError || !reports.length) {
        console.log(`📭 No reports for role ${role.title} today`);
        continue;
      }

      const { data: candidates, error: candidatesError } = await supabase
        .from('candidates')
        .select('id, name, email')
        .in('id', reports.map(r => r.candidate_id));

      if (candidatesError) {
        console.log(`⚠️ Failed to fetch candidates for role ${role.title}`);
        continue;
      }

      const candidateMap = Object.fromEntries(candidates.map(c => [c.id, c]));

      const emailBody = reports.map(report => {
        const c = candidateMap[report.candidate_id];
        return `- ${c.name} (${c.email}) — Score: ${report.overall_score}
  [View PDF](${report.report_url})`;
      }).join('\n\n');

      const msg = {
        to: clientData.email,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: `Candidate Reports for ${role.title} – ${format(now, 'MMMM d, yyyy')}`,
        text: `Here are the candidates submitted today for your role "${role.title}":\n\n${emailBody}`,
        html: `<p>Here are the candidates submitted today for your role <strong>${role.title}</strong>:</p><ul>${reports.map(report => {
          const c = candidateMap[report.candidate_id];
          return `<li><strong>${c.name}</strong> (${c.email}) – Score: ${report.overall_score}<br/><a href="${report.report_url}">View PDF</a></li>`;
        }).join('')}</ul>`
      };

      await sgMail.send(msg);
      console.log(`✅ Email sent to ${clientData.email} for role ${role.title}`);

      await supabase.from('digest_logs').insert({
        role_id: role.id,
        email: clientData.email
      });

      console.log(`📝 Logged digest for role ${role.title}`);
    }

    console.log('✅ Nightly digest job completed');
  } catch (err) {
    console.error('❌ Error sending nightly digests:', err.message);
  }
}

sendNightlyDigests();
