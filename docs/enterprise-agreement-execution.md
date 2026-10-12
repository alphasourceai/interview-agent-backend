# Prospective Enterprise execution artifacts

This integrates immutable signing into the real public `/sign` route for marked
Enterprise pool sources only. It does not enable checkout, paid activation,
credit release, legal publication, or the complete unified pricing release.

Migration `20261012151142_enterprise_execution_seals.sql` must precede this code.
Both marked and unmarked signing run the service-only native classifier before
storage. Missing schema/ambiguous classifier/malformed source holds rather than
falling through to overwriteable legacy paths. Existing legacy signing behavior
is retained after a native unmarked classification. No existing signed record
receives fabricated provenance or a seal. Historical marked rows may still be
voided, superseded, restored current or updated operationally as before.

New marked signatures require literal consent, a supported normalized typed
name and a real nonblank browser-canvas RGBA PNG. Existing retail decoder strips
metadata and records canonical bytes and pixel digest. Native UTC millisecond
time is fetched before rendering the existing Enterprise HTML. The PDF displays
its formatted date; exact timestamp is retained in the native execution seal.

Files use fresh server UUID attempt paths, `upsert:false`, private SDK metadata
and actual byte readback before signing. The configured artifact factory reads
keys only in `src/clients/supabase.js`, accepts only the real admin-client handle,
and exposes narrow methods rather than a key or general client. It inherits the
existing configured project/bucket, never another environment or fallback.
Provider/storage setup and actual Linux rendering still need dev acceptance.

Native BEFORE INSERT locks client then source and rejects changed/expired or
unrecognized source claims; absence of payment is not a signing denial nor paid access.
Specifically signing does not infer payment, Auth ownership or client access.
It verifies frozen snapshot, token, attempt paths, literal consent, name, hash/
size/pixel format and exact prepared/native clock window. AFTER INSERT invokes
the existing native signing RPC, matches its result, and commits seal/signing/
previous-current supersession in one transaction. Signing RPC now also takes
client-first locks so competing legacy/new sibling calls share lock order.
Seals have RLS, service INSERT/SELECT only, mutation denial and restricted FK.
No HTTP/storage/email occurs under native transaction locks.

Definite SQLSTATE/PGRST denial has no signing retry or recovery write. Unknown
response permits only PRIMARY same-attempt readback and exact stored-file/native
match. A recovered commit returns success but sends no email. Only INSERT201
plus exact native and byte readback permits the existing best-effort signed-copy
and internal emails. These are provider acknowledgments, not recipient proof.
Duplicate signed submissions preserve the existing409/no-effects response;
the existing `/session` route exposes signed state. No orphan cleanup deletes,
file overwrite, new attempt fallback in the same request or old-row backfill.

Native seal proves the server's immutable byte descriptors and winning source,
not PostgreSQL inspection of Storage bytes. Service verifies actual private
bytes. Privileged out-of-band bucket/object modifications remain external risks;
future checkout must re-read and compare sealed bytes. Historical marked sources
without seals must hold at future checkout rather than acquire fake provenance.

Tests distinguish fake-provider service/route behavior, isolated actual PG
transactions and actual macOS headless-PDF rendering from hosted acceptance.
The full release remains held until whole-source Grok+Codex review and dev E2E.
