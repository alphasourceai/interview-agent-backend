'use strict';

// Pins the wall clock for a test.
//
// The billing services take their "now" from the clock unless the caller passes
// asOf, and the HTTP routes never do. Several billing fixtures were written for
// September 2026 (usage in August, billed the following month), so without a
// pinned clock their result depends on the day the suite runs. FIXED_NOW is the
// same moment test/billing-usage-invoice-immediate.test.js already uses as NOW.

const FIXED_NOW = '2026-09-15T12:00:00.000Z';

function pinClock(at = FIXED_NOW) {
  const RealDate = global.Date;
  const fixed = new RealDate(at).getTime();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(fixed);
    }

    static now() { return fixed; }
  }
  global.Date = FixedDate;
  return () => { global.Date = RealDate; };
}

async function atFixedClock(fn, at = FIXED_NOW) {
  const restore = pinClock(at);
  try {
    return await fn();
  } finally {
    restore();
  }
}

module.exports = { FIXED_NOW, atFixedClock, pinClock };
