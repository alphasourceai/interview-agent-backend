# alphaScreen SMS owner compliance approval packet

Date: 2026-08-18  
Program: optional transactional interview-access verification codes  
Sender: dedicated verified alphaScreen toll-free sender  
Status: **APPROVED FOR QA IMPLEMENTATION**

This packet records the product and operational language approved by the alphaSource Network, LLC owner on 2026-08-18. It is not legal advice. The approval authorizes QA implementation of the language, retention schedule, and provider-neutral controls described below.

## 1. Candidate selection disclosure

Approved version: `sms-consent-v2`

> By selecting Text Message, you agree to receive transactional verification-code text messages you request from alphaScreen at the number shown above. Message frequency varies based on your verification requests and resends. Message and data rates may apply. Reply STOP to opt out or HELP for help. Text message consent is optional; you may choose Email instead. Review our Terms & Conditions and Privacy Policy.

Approval record:

- The message-frequency language is approved for this user-initiated OTP flow.
- The explicit Email alternative is approved; no additional employment-consideration sentence is required in this disclosure.
- Stable copy version `sms-consent-v2` is approved.

## 2. Approved Terms & Conditions addition

> **Optional transactional text messages.** When a candidate expressly selects Text Message, alphaScreen may send transactional interview-access verification codes requested by that candidate to the mobile number provided. Message frequency varies based on verification requests and resends. Message and data rates may apply. Reply STOP to opt out or HELP for help. Text message consent is optional and is not required to use the Email verification alternative. Opting out affects text-message delivery; Email verification remains available. Delivery may depend on mobile carriers and alphaScreen's contracted messaging provider.

Approval record:

- Add this as a new SMS section in the public Terms & Conditions.
- Candidate-specific Terms repeat the core optional-SMS terms and link to the public Terms and Privacy Policy.

## 3. Approved Privacy Policy addition

> **Mobile information and transactional verification messages.** If you select Text Message for interview-access verification, alphaScreen processes the mobile number and country you provide, the time and version of your selection, a keyed destination fingerprint, delivery and opt-out status, line-type classification, and limited provider delivery metadata. We use this information only to deliver and secure the requested verification flow, prevent abuse and excess spend, honor STOP and related control requests, investigate bounded delivery failures, and maintain compliance evidence. We may disclose the minimum necessary mobile information to contracted messaging, carrier, security, and infrastructure providers that process it for these purposes. We do not sell mobile information or share it with third parties for their own promotional or marketing purposes. Email verification remains available.

Approval record:

- The “not sold or shared for promotional or marketing purposes” statement is approved.
- Retain provider-neutral “contracted messaging provider” language.
- The description is approved as the business's intended use of mobile information.

## 4. STOP, START, and HELP operating copy

Approved policy:

- `STOP`: immediately create provider-independent local suppression and rely on the verified toll-free carrier/provider confirmation response. Do not send a second alphaScreen confirmation unless compliance review specifically requires one.
- `START` or `UNSTOP`: release only an `opted_out` suppression after a valid signed provider event. Never release admin, provider, or abuse blocks automatically.
- `HELP`: configure the provider response as:

> alphaScreen: Help with interview access: info@alphasourceai.com. Message and data rates may apply. Reply STOP to opt out.

Approval record:

- `info@alphasourceai.com` is the approved HELP channel.
- The Telnyx messaging profile must use this policy without conflicting duplicate replies.
- The separate AI Customer Support number remains unchanged and is not used as the authentication sender.

## 5. Approved data-retention schedule

The durations below are approved operational policy, not a statement of legally mandated periods.

| Data | Approved retention | Notes |
| --- | --- | --- |
| Active destination suppression | While active | Required to continue honoring opt-out/block state; fingerprint only. |
| Released suppression history | 4 years after release | Supports evidence of state transitions without plaintext phone storage. |
| SMS consent-selection evidence | 4 years after the selection or associated challenge, whichever is later | Timestamp, copy version, channel, binding, and fingerprint only. |
| Signed inbound STOP/START/HELP event record | 4 years | Provider/event ID, action, timestamp, and fingerprint; no message body. |
| Provider delivery telemetry | 13 months | Bounded states and failure categories; no OTP or raw phone. |
| Line-type cache | 30 days, then overwrite/expire | Fingerprint, provider, line type, and timestamps only. |
| Spend reservations and breaker events | 13 months | Cost-control evidence; no raw phone or IP. |
| OTP challenge verifier data | Existing durable OTP retention policy | No plaintext OTP; this packet does not change the accepted OTP policy. |

Approval record:

- Each listed duration is approved as drafted.
- Deletion must preserve an active suppression until it is validly released.
- The owner of alphaSource Network, LLC authorizes retention-policy changes.

## 6. Release evidence to retain

- Screenshot or stable rendered capture of the exact branded SMS opt-in path and `sms-consent-v2` disclosure.
- Verified toll-free sender status for the declared transactional 2FA use case.
- Canonical Terms and Privacy URLs used in the carrier registration.
- Telnyx messaging-profile STOP/START/HELP settings.
- Signed delivery and inbound webhook canary results after key rotation or provider-profile change.
- Evidence that Email remains the default alternative and SMS selection is explicit.
- Approval record with reviewer name/role, version, timestamp, and any required revisions.

## 7. Owner decision record

- Decision: `APPROVED`
- Reviewer: Jason Gardner
- Reviewer role/authority: Owner, alphaSource Network, LLC
- Approved version: `sms-operational-review-2026-08-18` with candidate disclosure `sms-consent-v2`
- Approved at: `2026-08-18T16:19:00Z`
- Required revisions: None

Approved runtime values:

- `SMS_COMPLIANCE_REVIEW_STATUS=approved`
- `SMS_COMPLIANCE_REVIEW_VERSION=sms-operational-review-2026-08-18`
- `SMS_COMPLIANCE_REVIEWED_AT=2026-08-18T16:19:00Z`
- `SMS_CONSENT_COPY_VERSION=sms-consent-v2`
