# Retail capability signer and exact executed PDF — local, unmounted

`membershipRetailSigning` exposes internal `session` and `sign` methods; no HTTP
route, sender, bucket, real legal version, buyer/client/contract linkage, access
grant or provider is connected. The prior issuer still discards its token and
reports delivery:not_configured. This is not a usable customer signing product.

## Authorization and immutable terms

Session body: documentId plus 43-character base64url capability. Sign adds only
typedName, JSON boolean consent:true and signatureDataUrl. No browser attempt,
path, time, money, buyer, legal or provider claim. Token hash preimage is the
existing fixed domain + document ID + frozen source fingerprint + token with LF
separators, SHA256 UTF8. The raw token/hash/private paths/HTML never appear in
the result. Safe buyer/company/offer/status and copied verified PDF bytes are
for a future internal HTTP wrapper; checkout and activation remain false.

Native service-only RPC locks original rep primary key, current source head and
latest legal gate, then samples clock_timestamp. Rep active, quote/link expiry
and current catalog do not close an issued customer window. Native deadline and
current source fingerprint do. Historical accepted data is re-read after a
waited head lock before expiry/revocation checks. Browser/PUBLIC execute revoked,
SECURITY INVOKER and pinned pg_catalog paths. No transaction spans file I/O.

## Signature bytes and replay identity

Isolated pure Node PNG parser (no native codec/provider import): exact MIME and
canonical standard base64; data URL and decoded bytes<=2MiB. Full chunk lengths,
CRC, order and terminal EOF. RGBA8/noninterlaced only; dimensions<=2048x1024 and
1,048,576 pixels before inflate. Bounded metadata grammar sRGB/gAMA/cHRM/pHYs/
sBIT/bKGD before contiguous IDAT; APNG/text/iCCP/unknown chunks rejected. Inflate
must consume every compressed byte and yield exactly (1+4*width)*height. PNG
filters0–4 decoded. Nonblank means at least one sample alpha>=32 and each RGB
channel<=230. This tests image structure, NOT authenticity/biometric identity.

Canonical PNG reencode drops metadata, uses filter0 and fixed zlib settings.
File SHA256 is over those exact stored bytes. Semantic replay SHA256 instead
uses UTF8 retail-signature-rgba-v1 + LF, width/height uint32 big-endian and raw
unfiltered RGBA. An immutable per-acceptance pixel record binds dimensions,
encoding, attempt and that identity in the SAME transaction as acceptance.
Old metadata-only acceptances without it fail closed, no automatic backfill.

Typed name is trim/NFC-normalized, 1..160 codepoints, no controls/angle brackets/
bidi and every character must exist in both shipped Raleway cmaps. It is a
signer attestation, not a buyer identity/name replacement or unpaid account grant.
Other scripts currently require additional reviewed font coverage before use.

## Execution and concurrency

Private preview download must match exact stored hash/size. The executed PDF
copies its original pages/resources using pinned pdf-lib1.17.1; the current
catalog/template/legal HTML is never rerendered. A separately rendered fixed
signature record is appended, with static inline packaged branding, escaped
name, explicit consent and exact document/source/attempt/legal/HTML/PDF/signature
references. Its native preparation time is explicitly NOT accepted_at or a paid
term start. Actual acceptance time is assigned by SQL only after CAS.

Active PDF actions (JS/AA/OpenAction/Launch/XFA/EmbeddedFiles/URI/Filespec) and
Metadata are rejected in parsed contexts, bounded at20,000 objects. Preview
may have frozen authoring Info; it is not eligibility. Merged output copies no
Info/XMP and creates no host-clock timestamp. Preview8MiB, receipt2MiB and2MiB
rebuild headroom fit executed12MiB; actual output/headroom/page caps checked.
The new migration widens only executed size CHECK, without rewriting old rows.

Before render, after render and after upload, native state is rechecked. Server
attempt UUID creates unique signature.png/executed.pdf keys. Copied bytes,
putIfAbsent/upsert:false, actual download equality before CAS, no transformations
or overwrite/delete. Concurrent observed-signable requests stage different
attempts; one wins and the other gets409, never winner success.

Unknown commit: one same-document/token/attempt primary readback returns the
acceptance AND pixel proof; all15 evidence fields and actual winning files must
match. No automatic second accept/upload/send. Missing/unreadable/incomplete503
holds. A later EXPLICIT request after authoritative absence can safely allocate
a NEW attempt and retain old orphan files. Native session waits on any still-
running acceptance then re-reads history. Proven same evidence after acceptance
is historical readback with no new attempt/render/write; different evidence409.

## Evidence and mount fences

Pure tests use independent native canvas as an oracle, not production codec.
Actual private PostgreSQL tests use parent migrations/RPCs and fake renderer/
private-file callbacks, including rollback+lost response, committed lost response,
concurrent signatures, waited sessions, revocation/source replacement and no
client/Auth/contract grants. Actual isolated Chrome+Poppler120DPI tests verify
each original copied page has zero pixel difference and signature record layout
is readable with Latin and160-character names. Local macOS is not Linux/hosted
Supabase/Auth/private-storage or real legal-signature acceptance.

Required before real mount: approved retail legal/refund version and real issued
renderer; encrypted durable delivery/outbox/recovery and subject/IP rate limits;
private bucket adapter/readbacks; inert buyer/contract mapping; native provider
binding/payment/UTC calendar alignment/activation/renewal fences; public/sales/
admin/client FE wiring and exact-source+hosted release gates. Legacy/Enterprise
signing and accepted historical terms remain unchanged.
