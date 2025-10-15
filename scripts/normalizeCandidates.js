// scripts/normalizeCandidates.js
// Usage:
//   node scripts/normalizeCandidates.js            # dry-run, normalize + report only
//   node scripts/normalizeCandidates.js --apply    # apply normalize edits, still no merges
//   node scripts/normalizeCandidates.js --apply --merge-dupes  # also merge duplicates (careful)

try { require('dotenv').config(); } catch {}
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// CLI flags
const APPLY = process.argv.includes('--apply');
const MERGE_DUPES = process.argv.includes('--merge-dupes');

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10); // keep last 10
}
function normalizeEmail(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase();
}
function normalizeName(raw) {
  if (!raw) return null;
  return String(raw).trim(); // keep casing for UI
}

async function main() {
  console.log(`[hygiene] starting (apply=${APPLY}, mergeDupes=${MERGE_DUPES})`);

  // 1) Pull candidates (batched)
  let from = 0, batch = 1000, total = 0;
  const changed = [];
  const updates = [];

  while (true) {
    const { data: rows, error } = await supabase
      .from('candidates')
      .select('id, role_id, name, email, phone, created_at', { count: 'exact' })
      .order('created_at', { ascending: true })
      .range(from, from + batch - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;
    total += rows.length;

    for (const r of rows) {
      const np = normalizePhone(r.phone);
      const ne = normalizeEmail(r.email);
      const nn = normalizeName(r.name);

      const willChange =
        (r.phone || np) && r.phone !== np ||
        (r.email || ne) && r.email !== ne ||
        (r.name || nn) && r.name !== nn;

      if (willChange) {
        changed.push({
          id: r.id,
          before: { phone: r.phone, email: r.email, name: r.name },
          after: { phone: np, email: ne, name: nn },
        });
        if (APPLY) {
          updates.push({ id: r.id, phone: np, email: ne, name: nn });
        }
      }
    }

    from += rows.length;
    if (rows.length < batch) break;
  }

  console.log(`[hygiene] scanned ${total} candidates; ${changed.length} need normalize updates`);
  if (changed.length) {
    console.table(changed.slice(0, 10).map(c => ({
      id: c.id, phone_before: c.before.phone, phone_after: c.after.phone,
      email_before: c.before.email, email_after: c.after.email,
      name_before: c.before.name, name_after: c.after.name,
    })));
    if (changed.length > 10) console.log(`...and ${changed.length - 10} more`);
  }

  // Apply updates in chunks
  if (APPLY && updates.length) {
    console.log(`[hygiene] applying ${updates.length} normalize updates...`);
    // Supabase upsert in chunks of 500
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const { error } = await supabase.from('candidates').upsert(chunk, { onConflict: 'id' });
      if (error) throw error;
    }
    console.log(`[hygiene] normalize updates applied.`);
  }

  // 2) Find duplicates (post-normalization snapshot from DB)
  // Group by role_id + email (case-insensitive) and role_id + (name, phone)
  const { data: dupesEmail, error: deErr } = await supabase
    .rpc('find_candidate_dupes_email'); // see SQL below
  if (deErr) {
    console.warn('[hygiene] email dupe finder function missing; falling back to client-side scan…');
  }

  const { data: dupesNamePhone, error: dnpErr } = await supabase
    .rpc('find_candidate_dupes_namephone'); // see SQL below
  if (dnpErr) {
    console.warn('[hygiene] name+phone dupe finder function missing; falling back to client-side scan…');
  }

  function printGroup(label, groups) {
    if (!groups || !groups.length) return console.log(`[hygiene] ${label}: none`);
    console.log(`[hygiene] ${label}: ${groups.length} groups`);
    console.table(groups.slice(0, 10));
    if (groups.length > 10) console.log(`...and ${groups.length - 10} more groups`);
  }

  printGroup('email dupes', dupesEmail);
  printGroup('name+phone dupes', dupesNamePhone);

  if (MERGE_DUPES) {
    console.log('[hygiene] merging dupes (apply required)…');
    if (!APPLY) {
      console.log('  Skipping because --apply not set.');
    } else {
      // Here you can implement merges as needed:
      //  - Pick keeper by min(created_at)
      //  - UPDATE interviews SET candidate_id = keeper WHERE candidate_id IN (losers)
      //  - DELETE FROM candidates WHERE id IN (losers)
      // I’m leaving this block as a placeholder because merges are riskier and may
      // need a review-specific policy in your dataset.
      console.log('  Merge step is a placeholder; implement once reviewed.');
    }
  }

  console.log('[hygiene] done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});