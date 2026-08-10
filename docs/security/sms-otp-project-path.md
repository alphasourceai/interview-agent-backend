# SMS OTP project path (not implemented)

SMS is not enabled by the durable-email phase, and no SMS vendor or sending number is selected. In particular, the AI Customer Support number `(605) 599-8008` must not be treated as SMS-capable without separate owner and carrier/provider confirmation.

## SMS-A — requirements and threat review

Confirm supported countries, accessibility needs, consent language, carrier requirements, abuse limits, delivery receipts, fallback rules, and retention. Define whether candidates choose email or SMS before challenge issuance.

## SMS-B — canonical phone normalization

Introduce a reviewed E.164 normalization module and migrate only the minimum candidate fields needed. Preserve raw display input separately if product requires it. Do not infer country from ambiguous local numbers.

## SMS-C — provider selection

Evaluate approved providers for number ownership, US A2P/10DLC compliance, international reach, delivery callbacks, spend controls, data retention, incident history, and sandbox support. Obtain explicit approval before adding an SDK or secret.

## SMS-D — delivery adapter

Add an `sms` adapter behind the existing provider-neutral delivery interface. It receives `{challengeId, destination, code, context}` and returns bounded delivery state. It must never persist or log the code/destination.

## SMS-E — channel-isolation tests

Prove email codes cannot verify SMS challenges and SMS codes cannot verify email challenges. Cover E.164 validation, opt-out/consent, delivery failure, rate limits, resend supersession, replay, concurrent sends, and cost-abuse limits.

## SMS-F — explicit fallback

Fallback must create a new challenge on the newly selected channel and supersede the prior challenge. Never reinterpret the same challenge across channels.

## SMS-G — QA-only deployment

Use a sandbox/test number and synthetic candidate. Require Grok and Codex approval, delivery/privacy evidence, zero real-candidate messages, and complete cleanup before any production plan.

## SMS-H — controlled production promotion

Reconstruct from the exact production baseline, configure secrets separately, use an opt-in rollout, monitor cost/delivery/error metrics, and retain an email-only rollback path.
