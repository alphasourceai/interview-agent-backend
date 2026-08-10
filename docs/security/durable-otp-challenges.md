# Durable OTP challenge architecture

## Security contract

Candidate email verification is challenge-addressed. The application returns an opaque `challenge_id`; the six-digit code exists only in process memory long enough to build the email. New codes are generated with `crypto.randomInt` and are never stored in plaintext.

`private_auth.otp_challenges` stores an HMAC-SHA-256 verifier, a secret-derived destination fingerprint, explicit resource bindings, database-authoritative expiry, atomic attempt counts, consume/supersede timestamps, and bounded delivery state. The HMAC input uses length-framed fields and binds the challenge ID, purpose, channel, normalized OTP, candidate, client, role, submission, interview attempt, and recovery authorization.

The private schema and table grant no access to `PUBLIC`, `anon`, `authenticated`, or `service_role`. RLS is enabled as defense in depth. Five narrow `public.service_*_otp_*` RPC boundaries are executable only by `service_role`; each is `SECURITY DEFINER` with an empty `search_path` and delegates to a private function. Client roles cannot inspect a verifier, destination fingerprint, or challenge row.

## Lifecycle

1. Candidate submission or an authorized recovery creates a new challenge through one atomic RPC.
2. Issuance takes a transaction-scoped advisory lock on the canonical candidate/client/role resource, supersedes every prior active challenge for that resource and channel even when a renewed submission changes the binding fingerprint, inserts exactly one new row, and neutralizes any matching active legacy token.
3. Email delivery updates only `pending`, `sent`, or `failed` state. Logs contain bounded IDs/status metadata, never the destination or code.
4. Resend accepts only the prior opaque challenge ID, resolves the server-side binding, and atomically replaces it. The old code cannot be consumed.
5. Verification retrieves the service-only HMAC context, performs `crypto.timingSafeEqual`, then calls an atomic row-locking consume RPC with only the boolean verifier decision.
6. A wrong code increments the attempt count. The fifth failure supersedes the challenge. Expired, consumed, and superseded challenges fail deterministically.
7. Successful consume updates the bound candidate verification state in the same database transaction.
8. The response sets a five-minute `__Host-` cookie with browser-required `Path=/`, `Secure`, no `Domain`, `HttpOnly`, and `SameSite=Lax`. Although the browser sends it to the host root as required by the prefix, only `/create-tavus-interview` consumes it. The signed capability is purpose- and resource-bound; it is cleared after a successful provider launch.

## Configuration

- `OTP_HMAC_SECRET_VERSION=1`
- `OTP_HMAC_SECRET_V1=<at least 32 random bytes, encoded as base64 or hex>`

The secret is environment-only. It must not be committed, logged, included in Sentry, or reused outside domain-separated OTP verifier, destination-fingerprint, and launch-capability inputs. Rotation requires a new versioned secret to remain available while unexpired challenges at the previous version drain.

## Legacy cutover

The migration first preserves the legacy table and audit row count, then replaces every retained `public.otp_tokens.code` value with `[removed]`, marks the rows used/invalidated, and adds a constraint preventing six-digit material from returning. New routes do not read or write the legacy table. The pre-existing internal legacy cleanup route explicitly excludes `[removed]` rows so it cannot erase the retained neutralized ledger after cutover. The table can be removed in a later isolated migration only after role-JD and historical recovery dependencies are reconstructed and production rollback requirements are satisfied.

## Privacy and observability

Allowed telemetry: route name, request correlation ID, candidate/role/client opaque IDs where already approved, channel, bounded outcome, and provider status code. Forbidden telemetry: OTP, verifier, HMAC secret, destination email/phone, raw request body, launch cookie, Authorization/Cookie headers, resume/transcript content, and message body. Sentry removes candidate OTP request bodies on submission and verification paths.

Challenge lifecycle does not create Admin Audit Log rows in this phase. Issuance, resend, delivery, consumption, expiry, and lockout are authentication mechanics rather than administrator actions; the private ledger is the durable lifecycle record and bounded operational telemetry is sufficient for incident diagnosis. A future administrator-initiated reset may add a separate actor-bound audit event, but must never include the destination, code, verifier, or cookie.

## Rollback

Before production deployment, retain the prior backend/frontend deployment identities and a catalog snapshot of `public.otp_tokens`. If application acceptance fails before any durable challenge is issued, roll back source, remove the five public wrapper functions, remove the five private functions and `private_auth.otp_challenges`, and then remove the empty private schema. Once the cutover migration has neutralized legacy plaintext, rollback must not restore the historical codes: recovery is reissuing fresh durable challenges after correcting the application failure. The legacy table and row count remain available for historical dependency compatibility, while its check constraint prevents a plaintext dual-auth path from returning.

## Channel contract

`email` is enabled. `sms` is represented only as a future channel enum and a disabled delivery capability. Purpose and channel are included in every verifier/binding so a code issued for one channel cannot be interpreted as another channel's challenge.
