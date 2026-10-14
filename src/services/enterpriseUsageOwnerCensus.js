'use strict';

// Complete bounded reads for the ORIGINAL usage-invoice caller. Exact counts
// and ordered keys detect truncation; they do not provide snapshot isolation or
// immutable allocation authority. The separate native invoice executor is held.
const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const CODE = 'enterprise_usage_owner_census_unavailable';
const validKey = value => typeof value === 'string' && value.trim() !== '';
const unavailable = () => ({ rows: null, error: { message: CODE } });

async function readAllPages(buildQuery, { key = 'id' } = {}) {
  const rows = [];
  let expectedCount;
  let previousKey;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE_SIZE;
      const result = await buildQuery().range(from, from + PAGE_SIZE - 1);
      if (!result || result.error || !Array.isArray(result.data)
        || result.data.length > PAGE_SIZE || !Number.isSafeInteger(result.count)
        || result.count < 0 || result.count > PAGE_SIZE * MAX_PAGES
        || (expectedCount !== undefined && expectedCount !== result.count)) return unavailable();
      expectedCount = result.count;
      for (const row of result.data) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !validKey(row[key])
          || (previousKey !== undefined && row[key] <= previousKey)) return unavailable();
        previousKey = row[key]; // Preserve the raw key; never sort/trim/coerce it.
        rows.push(row);
      }
      if (rows.length > expectedCount) return unavailable();
      if (rows.length === expectedCount) return { rows, error: null };
      if (result.data.length < PAGE_SIZE) return unavailable();
    }
  } catch (_) { return unavailable(); } // No provider/DB error text escapes.
  return unavailable(); // A capacity ceiling never certifies a partial prefix.
}

module.exports = { readAllPages, validKey, CODE };
