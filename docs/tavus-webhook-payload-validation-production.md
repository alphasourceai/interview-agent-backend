# Tavus webhook payload validation — production contract

This document describes the focused inbound payload contract for alphaScreen's production `POST /webhook/tavus` callback. It reconstructs the accepted QA Finding #6 semantics from commit `99736188d0b3ef9a4eb20fa01f22e6edadbd0101` while preserving production-specific event behavior. Sender authentication remains the first route middleware. The shared Tavus outbound HTTP client is not part of this contract.

## Official provider contract

Official Tavus references reviewed on 2026-08-09:

- <https://docs.tavus.io/sections/webhooks-and-callbacks>
- <https://docs.tavus.io/sections/event-schemas/conversation-utterance>
- <https://docs.tavus.io/sections/event-schemas/conversation-started-stopped-speaking>
- <https://docs.tavus.io/sections/event-schemas/conversation-toolcall>
- <https://docs.tavus.io/sections/event-schemas/conversation-perception-tool-call>
- <https://docs.tavus.io/sections/event-schemas/conversation-perception-analysis>

Conversation callbacks use a top-level string `event_type` and top-level string `conversation_id`. Event-specific fields differ and generally live under `properties`. Tavus documents conversation identifiers as strings and does not require alphaScreen to interpret them as UUIDs. Additional fields are allowed and ignored unless alphaScreen consumes them.

## Common envelope

After successful callback authentication and bounded JSON parsing, the root must be a non-array object with its own properties. The validator requires:

- `event_type`: a non-empty, control-character-free string of at most 120 characters;
- a canonical Tavus conversation identifier: a non-empty, control-character-free string of at most 200 characters;
- minimum valid structure for fields consumed by a supported event.

Event names are exact and case-sensitive. No fuzzy or case-insensitive reinterpretation occurs. Tavus's documented `system.pal_joined` callback normalizes to alphaScreen's existing internal `system.replica_joined` behavior because Tavus documents the payloads as identical.

## Canonical conversation identifier

Accepted locations are intentionally closed:

| Location | Classification |
| --- | --- |
| `conversation_id` | `CURRENT_TAVUS_CONTRACT` |
| `properties.conversation_id` | `REQUIRED_LEGACY_COMPATIBILITY` |
| `payload.conversation_id` | `REQUIRED_LEGACY_COMPATIBILITY` |
| `payload.properties.conversation_id` | `REQUIRED_LEGACY_COMPATIBILITY` |

Outer whitespace is normalized. If multiple accepted locations are populated, every normalized value must be identical. A disagreement is `conflicting_conversation_ids` and produces a generic 400 response before any binding lookup or product mutation.

Former camel-case, metadata, nested `conversation.id`, and `application_id` families are not accepted. They are classified as obsolete or unsafe ambiguous. AlphaScreen does not infer a conversation identifier from arbitrary `id` fields.

## Supported event behavior

| Canonical event | Minimum fields alphaScreen validates | Existing action |
| --- | --- | --- |
| `system.replica_joined` | common envelope; `properties` must be an object if present | record join lifecycle and preserve current status behavior |
| `system.shutdown` | common envelope; `properties` must be an object if present | record lifecycle and apply current shutdown transition |
| `application.transcription_ready` | transcript array or supported messages envelope | final transcript reconciliation and existing dedupe/claims |
| `application.recording_ready` | valid consumed URL/storage/duration signal | existing recording-state handling |
| `application.perception_analysis` | string or object analysis | existing post-call perception path |
| `conversation.perception_analysis` | string or object analysis | existing interaction perception path |
| `conversation.utterance` | consumed role/speech fields must have safe types | existing lifecycle ingestion |
| `conversation.tool_call` | bounded tool name; arguments string/object if present | existing terminal-tool behavior |
| `conversation.started_speaking` | consumed properties must have safe types | existing lifecycle event |
| `conversation.stopped_speaking` | consumed role/interrupted/duration fields must have safe types | existing lifecycle event |
| `conversation.connected` | common envelope | retained lifecycle compatibility |
| `conversation.disconnected` | common envelope | retained lifecycle compatibility |

Unsupported event names with a valid common envelope are acknowledged as `{ "ok": true, "ignored": true }`. They do not reach binding lookup or product mutation. Malformed common or event-specific data returns HTTP 400 with `{ "ok": false, "error": "invalid_webhook_payload" }`.

Production does not enable QA's `conversation.perception_tool_call` ingestion branch. That event remains unsupported and is safely ignored before binding rather than introducing QA-only business behavior.

## Binding and replay boundary

Payload validation proves structure and internal identifier consistency only. It does not prove the event belongs to an alphaScreen interview. The existing provider-conversation binding lookup remains separate and occurs only after validation. Existing final-transcript claims, perception dedupe keys, lifecycle dedupe keys, terminal-call single-attempt behavior, and recording-state protections remain authoritative.

## Parser and privacy contract

The active middleware order is:

1. authenticate Tavus callback sender;
2. parse JSON with the existing finite 10 MB limit;
3. normalize and validate the callback;
4. resolve the application binding;
5. process a supported event.

Malformed JSON receives the same generic payload error without echoing parser details. Validation telemetry is limited to a bounded category, `identifier_present`, `identifier_conflict`, and a safely normalized event name when available. It never includes the raw body, transcript text, recording or signed URLs, candidate PII, callback secret, Tavus API key, or complete headers.
