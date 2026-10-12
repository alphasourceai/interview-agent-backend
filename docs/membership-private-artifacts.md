# Private membership artifact SDK adapter (unmounted)

createMembershipPrivateArtifacts receives copied server configuration:
projectRef, bucket, namespace (retail-v2 or enterprise-v2), serviceKey. An optional
trusted fetchImplementation exists for testing. Never construct it from browser
input or expose credentials; no environment/key is read or changed by this module.
It builds its own Supabase client with session persistence, auto-refresh, URL
session detection and alternate storage hostname disabled. Only the two frozen
methods putIfAbsent/readPrivate are returned, not a DB/Auth or Storage handle.

The request wrapper permits only the configured HTTPS project, bucket GET,
canonical namespace object POST/GET and metadata GET. No query, transform,
public/signed URL, list, delete, policy update, legacy fixed path or redirect.
Uploads carry exact MIME, x-upsert:false and cache-control:no-store. Source/user
authorization still belongs to the native issuer/signer service, not this adapter.

Per-path limits match retail callers: preview PDF8MiB, executed PDF12MiB and
PNG2MiB, all minimum16bytes. PNG requires its eight-byte signature; PDF requires
%PDF- plus %%EOF in the last1024bytes. Intrinsic byteOffset/byteLength accessors
copy binary views synchronously before any await; SharedArrayBuffer/proxies deny.
Options may be plain or null-prototype objects, but must contain exactly the two
own enumerable data properties contentType and literal upsert:false. Getters,
symbols, inherited options and unknown fields never become upload settings.

Private bucket metadata is checked before and after operations; id/name match
and public is false, optional bucket caps/MIME restrictions support the protocol.
Before a body download, installed SDK info(path) supplies FileObjectV2's numeric
top-level size, name/bucketId/contentType; missing/invalid/oversized metadata holds
before body I/O. download(path) takes NO transform/options. Its native Blob must
have the same size/MIME and match byte-shape predicates; returned Buffer is copied.

One upload only. Known success still reads and compares exact retained bytes,
hash and size. Transport ambiguity or408/425/429/500/502/503/504 may recover by
one same-path metadata/body read. Other statuses deny without read/retry. Missing
or corrupt recovery never creates another object or overwrites/removes one.
Three bucket checks plus one metadata read intentionally retain the final
post-download check to detect a mid-operation public toggle. No write retry.
Errors have fixed code, empty message and no raw cause/token/customer/provider text.

Limits: private bucket checks are snapshots, not permanent policy enforcement.
An external privileged writer can race metadata/body or toggle bucket visibility;
SDK download buffers internally, so metadata preflight is NOT a streamed-memory
guarantee. Actual hosted API metadata/ACL/storage acceptance remains untested.
Local tests use the real installed SDK2.55.0/storage-js2.10.4 with intercepted
synthetic fetch, not a real project/key/upload. This does not seal Enterprise's
legacy fixed-path artifacts, publish legal terms, create buyers, mount routes,
prove provider/customer ownership, grant credits or complete the unified release.
