# SMS-C2 candidate UI and QA delivery

SMS-C2 connects the existing provider-neutral durable OTP foundation to the candidate flow. It adds no schema, sender, credential, webhook, or production change.

## Default state

Candidate SMS is disabled unless every backend gate is explicitly satisfied:

- `SMS_CANDIDATE_UI_ENABLED=true`
- `SMS_ENABLED=true`
- `SMS_ENVIRONMENT=qa`
- `SMS_PROVIDER=telnyx`
- `SMS_CONSENT_COPY_VERSION=sms-consent-v2`
- the existing Telnyx adapter configuration is valid

The frontend independently requires `VITE_SMS_OTP_UI_ENABLED=true`. With that variable absent or false, the existing email-only candidate UI remains visible and email remains the default channel.

Automated tests use `SMS_ENVIRONMENT=local`, `SMS_PROVIDER=fake`, and `NODE_ENV=test`. The fake adapter has no network transport and is rejected outside local test/development execution.

## Candidate contract

- SMS is offered only for a valid US phone selection.
- Any otherwise eligible US destination may be used in QA; there is no number-specific destination allowlist.
- Existing suppression, candidate-submit rate limiting, role/resource binding, and duplicate-candidate rules still apply.
- Email is selected by default.
- Selecting Text Message submits `otp_channel=sms` and `consent_copy_version=sms-consent-v2`; the backend records the selection timestamp.
- The durable challenge is committed before the provider adapter is invoked.
- A provider outcome never verifies or consumes the challenge.
- Non-accepted and ambiguous outcomes never trigger an automatic retry or silent email send. The candidate must explicitly choose Email, which issues a new cross-channel challenge and supersedes the prior active challenge.
- Responses expose only bounded channel/outcome/fallback metadata. They do not expose canonical phone, OTP, destination fingerprint, provider message ID, or provider response bodies.

## Owner gate

Do not change either candidate UI flag or send a live QA SMS without separate owner approval. Production remains out of scope.
