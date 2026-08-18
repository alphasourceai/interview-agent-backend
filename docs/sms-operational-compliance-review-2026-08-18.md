# alphaScreen SMS operational and compliance review

Date: 2026-08-18
Scope: transactional interview-access OTP over the dedicated alphaScreen toll-free sender
Status: **OWNER APPROVED FOR QA IMPLEMENTATION**

This is an engineering and product-controls review, not legal advice. The owner approval recorded in `sms-compliance-owner-approval-packet-2026-08-18.md` authorizes the reviewed QA implementation and the approved runtime status.

## Official guidance reviewed

- [Telnyx toll-free verification](https://developers.telnyx.com/docs/messaging/toll-free-verification) — carrier verification, 2FA use-case fields, privacy/terms URLs, HELP response, opt-in confirmation, and current business-registration fields.
- [Telnyx toll-free verification request guide](https://support.telnyx.com/en/articles/10729979-toll-free-verification-request-guide) — branded digital opt-in evidence, separate optional SMS selection, STOP/HELP, message/data rates, frequency disclosure, privacy and terms links, and mobile-information language.
- [Telnyx advanced opt-in/out management](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out) — default STOP/START/UNSTOP handling, HELP configuration, profile-wide block scope, webhook `autoresponse_type`, and carrier-level toll-free opt-out behavior.
- [Telnyx messaging webhook guidance](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks) — Ed25519 signature verification, timestamp replay tolerance, deduplication, out-of-order events, HTTPS, and bounded response time.
- [FCC consent-revocation order FCC 24-24](https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf) — reasonable revocation methods, standard reply keywords, honoring opt-out, and limits on confirmation texts.
- [CTIA Messaging Principles and Best Practices overview](https://www.ctia.org/messaging-channel) — consent before non-consumer messaging and a working opt-out path.

## Current alphaScreen controls

| Control | Engineering finding |
| --- | --- |
| Message purpose | Transactional interview-access OTP only; no marketing content in this flow. |
| Choice | Email remains the default and alternative. SMS requires an explicit candidate selection. |
| Disclosure | Versioned disclosure identifies alphaScreen, a one-time transactional code, message/data rates, STOP, HELP, and the email alternative. |
| Evidence | Challenge-bound `sms_selection_at`, `consent_copy_version`, destination fingerprint, resource binding, and channel are stored privately. |
| Authentication authority | alphaScreen creates and verifies the OTP; Telnyx is transport only. |
| Opt-out independence | Private alphaScreen suppression state blocks future sends independently of provider state. |
| Inbound controls | Signed, deduplicated STOP/START/HELP events and provider/carrier opt-out behavior are supported in the production safety architecture. |
| Delivery events | Signed provider callbacks update telemetry only and cannot verify, consume, extend, or reactivate a challenge. |
| Line type | Production safety architecture fails closed unless the destination resolves to mobile. |
| Abuse and spend | Candidate/resource/destination/IP controls and an atomic daily spend reservation/breaker exist in the production safety architecture. |
| Privacy | Operational telemetry is aggregate; raw phone, OTP, provider message ID, destination fingerprint, and candidate identity are excluded from the admin monitoring response. |

## Ongoing release evidence

- Preserve a screenshot or stable rendered capture of the exact branded opt-in path and its disclosure version.
- Confirm the currently assigned toll-free sender remains verified for the declared 2FA use case before each production release that changes sender or program details.
- Confirm the canonical Terms and Privacy URLs in the carrier registration still resolve and match the candidate flow.
- Confirm Telnyx profile-level opt-out scope is intentional because one STOP can block the destination across every number on that messaging profile.
- Confirm carrier toll-free STOP/UNSTOP replies and any alphaScreen/Telnyx custom replies do not contradict or unnecessarily duplicate one another.
- Exercise signed delivery and inbound webhooks after any key rotation; retain only bounded event evidence.
- Confirm HELP supplies a monitored support method without repurposing or changing the AI Customer Support number.
- Define and approve a retention schedule for consent evidence, inbound control events, delivery telemetry, line-type cache, and spend reservations.

## Resolved policy items

1. The owner approved disclosure version `sms-consent-v2`, including the message-frequency language and explicit Email alternative.
2. The owner approved the transactional SMS addition to the public and candidate Terms.
3. The owner approved the provider-neutral mobile-information addition to the Privacy Policy.
4. The owner approved the retention periods and the rule preserving active suppressions until valid release.
5. The authoritative reviewer, review version, and approval timestamp are recorded in the owner approval packet.

## Monitoring contract

The Super Admin SMS Monitoring page is read-only. It may display aggregate delivery, failure, consent-version, suppression, inbound-keyword, line-type, spend, and breaker totals plus bounded failure categories. It must never display or return raw phone numbers, OTPs, destination fingerprints, provider message IDs, candidate identities, or credential values.

Runtime fields:

- `SMS_COMPLIANCE_REVIEW_STATUS`: `not_recorded`, `pending`, or `approved`
- `SMS_COMPLIANCE_REVIEW_VERSION`: stable bounded review identifier
- `SMS_COMPLIANCE_REVIEWED_AT`: ISO timestamp of the authorized decision

The approved QA runtime values are recorded in the owner approval packet.
