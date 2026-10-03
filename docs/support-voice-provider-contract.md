# Support voice provider contract (2026-10-03)

The browser support gateway and its no-audio canary send the same authoritative
session update to xAI. The current [realtime WebSocket schema](https://docs.x.ai/voice-realtime.ws.json)
documents `turn_detection.type` and `turn_detection.idle_timeout_ms`, but not
VAD threshold, silence duration, or prefix padding. We request only
`{"type":"server_vad","idle_timeout_ms":null}`. The provider may echo either
`{"type":"server_vad"}` or the same object with `idle_timeout_ms:null`.
Any additional turn-detection field or non-null idle timeout fails closed.

A no-audio probe against the QA provider on 2026-10-03 echoed only
`{"type":"server_vad"}` after this documented update. It did not send audio,
create a customer session, or reveal credentials. VAD sensitivity and timing
are provider-managed; this contract does not claim an exact numeric setting.
All existing prompt, model, audio-only, transcription-off, tool, retention,
resumption, and transport attestations remain in force. A fresh Grok verdict
on the exact code candidate is required before QA or production deployment.
