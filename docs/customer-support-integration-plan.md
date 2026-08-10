# AI Customer Support integration plan (not implemented)

The approved public support label is **AI Customer Support** and the approved phone presentation is **(605) 599-8008**, linked as `tel:+16055998008`. This document is a future implementation plan only; it does not modify the website, dashboard, xAI agent, PAL/persona, or call behavior.

## Website path

1. Add a small AI Customer Support entry to the global support/footer surface using the approved label and phone link.
2. Add bounded context explaining when to call and preserve existing email/accommodation channels.
3. If browser voice is later approved, add a separate “Talk to AI Customer Support” control with clear microphone consent and a visible phone fallback.
4. Test responsive layout, keyboard/screen-reader access, `tel:` behavior, analytics privacy, and support availability copy.

## Dashboard path

1. Add the same label/phone link to the existing Help/Support surface rather than creating a competing navigation system.
2. Pass only the minimum tenant-safe support context. Do not expose candidate, transcript, OTP, billing secret, or service-role data to a support agent.
3. Define manager/member authorization for any account-aware diagnostic actions; begin read-only and require explicit confirmation for mutations.
4. Add audit events for approved account actions without recording conversation content by default.

## xAI browser-voice path

1. Confirm the current official xAI browser/realtime voice contract and the exact existing `alphaSource Support` voice-agent identifier in the owner's `console.x.ai` workspace.
2. Create a backend endpoint that returns a short-lived, narrowly scoped browser session credential. Never expose the permanent xAI API key to the browser.
3. Request microphone permission only after an explicit click. Show connected, listening/muted, elapsed, disconnect, and error states.
4. Apply bounded session duration, concurrency, abuse controls, origin checks, and disconnect cleanup.
5. Send only the minimum support context. Do not send OTPs, resumes, transcripts, signed recording URLs, or unrelated tenant data.
6. Default to no recording or persistent transcript. Any retention requires a separate privacy, consent, access-control, and deletion design.
7. Provide the phone link on every failure path and do not claim emergency or human support capabilities that are not actually staffed.
8. Validate locally, then in QA with synthetic support questions, Grok/Codex review, privacy/log inspection, and explicit owner acceptance before production.
