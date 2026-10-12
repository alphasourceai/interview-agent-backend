# Accepted Enterprise platform cadence (pure, unmounted)

The positive pool payment proof now requires both platformCents (positive integer
cents) and platformInterval (exact month or year) from the frozen native source.
No platformMonthlyCents default or alias is accepted, even if present as null or
undefined. Only test helpers currently call this function. Future trusted SDK
adapters must map the actual frozen operation's platform_cents/platform_interval;
browser values, metadata, JSON-shaped graphs and current client settings are
not authentication or evidence of ownership.

All three platform Price copies must agree with the accepted nominal fee and
cadence: licensed, interval_count1, exact cents and currency/mode/identity. A
year is not converted to month12 or multiplied/divided by12. The pool remains
one-time and full positive net must be collected. Platform initial proration
may be0..nominal; a nonprorated line must equal nominal. Actual captured invoice
totals, independent taxes, no provider discounts/refunds, complete lists and
account/customer/links retain the same predicates for either cadence.

The returned platform_nominal_cents/platform_interval are the full accepted fee
and cadence, not the initial prorated amount. platform_line_cents is still the
actual initial line. credits_spendable=false and activation/native receipt
requirements remain true. This neither verifies proration math/calendar anchor
nor grants a full year of access. Real provider proof, native receipt and genuine
activation remain separately required. Monthly usage invoicing is unchanged.
No provider calls, writes, credentials, route or worker are introduced.
