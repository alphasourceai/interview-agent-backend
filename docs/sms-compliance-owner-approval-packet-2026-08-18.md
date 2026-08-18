# alphaScreen SMS owner compliance approval packet

Date: 2026-08-18  
Program: optional transactional interview-access verification codes  
Sender: dedicated verified alphaScreen toll-free sender  
Status: **DRAFT — LEGAL/COMPLIANCE REVIEW REQUIRED**

This packet records proposed product and operational language. It is not legal advice and does not itself constitute approval. Do not set `SMS_COMPLIANCE_REVIEW_STATUS=approved` until an authorized reviewer approves the final language, retention schedule, and provider configuration.

## 1. Candidate selection disclosure

Proposed version: `sms-consent-v2`

> By selecting Text Message, you agree to receive transactional verification-code text messages you request from alphaScreen at the number shown above. Message frequency varies based on your verification requests and resends. Message and data rates may apply. Reply STOP to opt out or HELP for help. Text message consent is optional; you may choose Email instead. Review our Terms & Conditions and Privacy Policy.

Approval questions:

- Is “message frequency varies based on your verification requests and resends” acceptable for this user-initiated OTP flow?
- Should the copy also state that SMS consent is not a condition of employment consideration, or is the explicit Email alternative sufficient?
- Approve the stable copy version `sms-consent-v2`.

## 2. Proposed Terms & Conditions addition

> **Optional transactional text messages.** When a candidate expressly selects Text Message, alphaScreen may send transactional interview-access verification codes requested by that candidate to the mobile number provided. Message frequency varies based on verification requests and resends. Message and data rates may apply. Reply STOP to opt out or HELP for help. Text message consent is optional and is not required to use the Email verification alternative. Opting out affects text-message delivery; Email verification remains available. Delivery may depend on mobile carriers and alphaScreen's contracted messaging provider.

Approval questions:

- Approve this as a new SMS section in the public Terms & Conditions.
- Confirm whether candidate-specific Terms should repeat or link to this language.

## 3. Proposed Privacy Policy addition

> **Mobile information and transactional verification messages.** If you select Text Message for interview-access verification, alphaScreen processes the mobile number and country you provide, the time and version of your selection, a keyed destination fingerprint, delivery and opt-out status, line-type classification, and limited provider delivery metadata. We use this information only to deliver and secure the requested verification flow, prevent abuse and excess spend, honor STOP and related control requests, investigate bounded delivery failures, and maintain compliance evidence. We may disclose the minimum necessary mobile information to contracted messaging, carrier, security, and infrastructure providers that process it for these purposes. We do not sell mobile information or share it with third parties for their own promotional or marketing purposes. Email verification remains available.

Approval questions:

- Approve the “not sold or shared for promotional or marketing purposes” statement.
- Approve naming Telnyx in the policy or retaining the provider-neutral “contracted messaging provider” language.
- Confirm that this description matches the business's intended use of mobile information.

## 4. STOP, START, and HELP operating copy

Proposed policy:

- `STOP`: immediately create provider-independent local suppression and rely on the verified toll-free carrier/provider confirmation response. Do not send a second alphaScreen confirmation unless compliance review specifically requires one.
- `START` or `UNSTOP`: release only an `opted_out` suppression after a valid signed provider event. Never release admin, provider, or abuse blocks automatically.
- `HELP`: configure the provider response as:

> alphaScreen: Help with interview access: info@alphasourceai.com. Message and data rates may apply. Reply STOP to opt out.

Approval questions:

- Confirm `info@alphasourceai.com` is the monitored HELP channel.
- Confirm the Telnyx messaging profile's automatic STOP/START/HELP responses match this policy and do not create conflicting duplicate replies.
- Confirm that the separate AI Customer Support number remains unchanged and is not used as the authentication sender.

## 5. Proposed data-retention schedule

The durations below are proposed operational policy, not a statement of legally mandated periods. Authorized legal/compliance review is required.

| Data | Proposed retention | Notes |
| --- | --- | --- |
| Active destination suppression | While active | Required to continue honoring opt-out/block state; fingerprint only. |
| Released suppression history | 4 years after release | Supports evidence of state transitions without plaintext phone storage. |
| SMS consent-selection evidence | 4 years after the selection or associated challenge, whichever is later | Timestamp, copy version, channel, binding, and fingerprint only. |
| Signed inbound STOP/START/HELP event record | 4 years | Provider/event ID, action, timestamp, and fingerprint; no message body. |
| Provider delivery telemetry | 13 months | Bounded states and failure categories; no OTP or raw phone. |
| Line-type cache | 30 days, then overwrite/expire | Fingerprint, provider, line type, and timestamps only. |
| Spend reservations and breaker events | 13 months | Cost-control evidence; no raw phone or IP. |
| OTP challenge verifier data | Existing durable OTP retention policy | No plaintext OTP; this packet does not change the accepted OTP policy. |

Approval questions:

- Approve, shorten, or extend each proposed duration.
- Confirm deletion must preserve an active suppression until it is validly released.
- Identify the role authorized to approve retention-policy changes.

## 6. Release evidence to retain

- Screenshot or stable rendered capture of the exact branded SMS opt-in path and `sms-consent-v2` disclosure.
- Verified toll-free sender status for the declared transactional 2FA use case.
- Canonical Terms and Privacy URLs used in the carrier registration.
- Telnyx messaging-profile STOP/START/HELP settings.
- Signed delivery and inbound webhook canary results after key rotation or provider-profile change.
- Evidence that Email remains the default alternative and SMS selection is explicit.
- Approval record with reviewer name/role, version, timestamp, and any required revisions.

## 7. Owner decision record

Do not complete this section until the final language has been reviewed.

- Decision: `PENDING`
- Reviewer: `PENDING`
- Reviewer role/authority: `PENDING`
- Approved version: `PENDING`
- Approved at: `PENDING`
- Required revisions: `PENDING`

After approval, runtime may be set to:

- `SMS_COMPLIANCE_REVIEW_STATUS=approved`
- `SMS_COMPLIANCE_REVIEW_VERSION=<approved stable version>`
- `SMS_COMPLIANCE_REVIEWED_AT=<ISO timestamp>`

Until then, runtime must remain `pending` or `not_recorded`.
