# Private capability envelope — pure local component

No real keys, environment lookup, SDK, database, sender, route or file storage.
This module alone neither makes a usable link nor grants permission to send it.

Factory requires explicit dev/staging/production environment, active key ID and
1..4unique32-byte byte-array keys. Owned copies, Map lookup (including IDs named
constructor or __proto__), duplicate-byte rejection, exact nonzero-offset views.
New seals only use active key. Old envelopes decrypt only while that key is
explicitly configured. destroy zeroes owned buffers and permanently disables
the instance; no claim that JavaScript strings or crypto internals are erased.
Internal keyIdentity exposes SHA256 of the ACTUAL owned key plus environment/ID,
never bytes; native delivery registry must match it. One enumerable data-
descriptor snapshot is used for validation/AAD/results; accessors, nonenumerable
fields and all Proxies rejected. Input inspection cannot call changing getters.
The source/issuer use the same extracted email/version grammar. Pure errors have
no HTTP status or automatic retry policy. Temporary AAD/hash/cipher/tag bytes
are cleared along with plaintext, with no forensic-erasure guarantee.

Two distinct closed server bindings:

- sales_email_link_v1: environment, source_id, source_fingerprint, normalized
  buyer_email, token_hash. Existing SHA256sales-email-link-v1/source/token domain
  unchanged; contact proof is not buyer Auth or legal acceptance.
- retail_signer_v2: environment, document_id, source_fingerprint, buyer_email,
  legal_version, html_sha256, preview_pdf_sha256, token_hash. Existing SHA256
  retail-signing-v2/document/source-fingerprint/token domain unchanged.

seal validates canonical32-byte unpaddedbase64url token and exact domain hash;
AES256GCM uses random12-byte nonce and explicit16-byte tag. Recursive sorted
JSON AAD binds protocol/key ID/purpose/full closed binding. Frozen envelope
contains protocol/key_id/binding/nonce/ciphertext/tag, never rawtoken/key.
Header buyer email remains private PII, not encrypted by this wrapper.

open requires independently loaded authoritative binding, exact header match,
known key and canonical encodings/fixed decoded12/43/16-byte lengths before
decrypt. setAAD/setAuthTag before final; no update plaintext returned until
authentication succeeds. UTF8pluscanonical alphabet prevents high-bit ASCII
masking; full native-domain token hash checked again. Temporary plaintext bytes
zeroed in finally. Generic errors contain no raw input, key, cause or provider
diagnostic. The returned raw token is INTERNAL/ephemeral for a future sender,
never a browser DTO, log or plaintext database record. open is repeatable
decryption, not a one-time delivery claim or nonce ledger.

## Tests and remaining gates

Both domains/independent encrypt/decrypt oracle, all binding-field substitutions,
environment/purpose/key swaps, byte tampering and unused-base64 bits, Unicode
plaintext attack, exact body/prototypes/accessors/oversized strings, renamed
same-key AAD, key view/copy/mutation, rotation/retirement/destroy and generic
unexpected diagnostics tested with synthetic in-memory keys and .invalid mail.

Design Grok APPROVE session01a12d91-d3c0-7b41-bed2-975bf53e9b9c; exact source
review still required. Parent signer local review is separate from deployment.

Future outbox MUST bind header to native issued/source rows, enforce native
global per-key seal ceiling/rotation and unique(key_id,nonce), private RLS/log
redaction, one automatic claim/send attempt, held ambiguous sends, pinned
origin and verified recipient/admission/rates. This pure factory has no global
counter across process restarts and makes no global nonce-uniqueness guarantee.
Do not mount until those rules and whole source/hosted gates pass. Persisting a
secret-bearing envelope or real key requires separate reviewed configuration.
