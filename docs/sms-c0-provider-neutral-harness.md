# SMS-C0 provider-neutral QA harness

SMS-C0 adds no live SMS route, provider SDK, credential, sender, callback, or candidate UI. The application continues to use alphaScreen's durable OTP challenge as the sole authentication authority.

The trusted database boundary is `service_record_otp_sms_delivery_metadata`. It is executable only by `service_role`, writes only bounded delivery telemetry, uses database-authoritative timestamps, and cannot modify verifier, binding, expiry, attempt, consume, or supersession state. The existing email delivery RPC remains unchanged.

The deterministic fake adapter is available only when explicitly constructed for `local` or `qa`. It has `network: none`, rejects production, performs exactly one adapter invocation, and never retries or cascades to another provider. The controlled harness also replaces Node network entry points with a blocking counter and requires:

```sh
SMS_ENVIRONMENT=qa node scripts/runSmsC0FakeHarness.js --controlled-qa-harness
```

The output is deliberately sanitized. It reports normalized outcomes, call counts, metadata event names, retry/failover flags, and the network-attempt count. It never prints the OTP, destination, SMS body, message ID, idempotency identity, provider response, or candidate PII.

Any future network-capable QA adapter must be explicitly enabled in SMS-C1 and use an owner-approved allowlist of keyed destination fingerprints. Raw phone numbers are not accepted as allowlist entries. No destination is configured or populated by SMS-C0.

Delivery callback support remains a fixture-only normalized contract. No HTTP callback route or signature abstraction is mounted until a provider is selected.
