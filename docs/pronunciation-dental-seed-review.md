# Pronunciation registry and dental seed — QA review record

## Runtime rule

The alphaScreen registry is authoritative. Tavus receives a deterministic,
resolved copy containing only records where `verification_status = verified`
and `is_active = true`. Resolution order is client, then industry, then global.
Canonical role, job-description, rubric, and interview text is never rewritten.

The initial inventory contains 36 dental terms. Nine have recognized lexical,
medical, or curated acronym evidence and are eligible for QA synchronization;
27 remain suggested and are excluded. The six current QA dental roles contain
no occurrences of Open Dental, Dentrix, Eaglesoft, Invisalign, CBCT, or CAD/CAM,
so no brand was promoted merely because it appeared in the requested inventory.

## Reviewed inventory

| Canonical term | Category | Method | Proposed pronunciation | Source | Confidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| endodontics | specialties | IPA | ˌɛndoʊˈdɑntɪks | Collins American English | high | verified, v2 listening PASS |
| periodontics | specialties | IPA | ˌper.i.oʊˈdɑːn.t̬ɪks | Cambridge US | high | verified, v2 listening PASS |
| prosthodontics | specialties | IPA | ˌprɑːs.θoʊˈdɑːn.t̬ɪks | Cambridge US | high | verified, v2 listening PASS |
| orthodontics | specialties | IPA | ˌ\|ɔː\|r\|θ\|oʊ\|ˈ\|d\|ɑː\|n\|t̬\|ɪ\|k\|s | Cambridge US; Tavus pipe-delimited format | high | verified, v3 listening PASS |
| oral and maxillofacial surgery | specialties | alias | unchanged | none established | unverified | suggested |
| pediatric dentistry | specialties | alias | unchanged | none established | unverified | suggested |
| xerostomia | clinical/anatomy | IPA | ˌzɪərəˈstoʊmiə | Dictionary.com American IPA; consistent with NCI | high | verified, v2 listening PASS |
| occlusion | clinical/anatomy | alias | unchanged | none established | unverified | suggested |
| malocclusion | clinical/anatomy | alias | unchanged | none established | unverified | suggested |
| gingiva | clinical/anatomy | alias | jinjivuh | Cambridge US target; owner voice reference retained locally only | owner reference | verified, v5 listening PASS |
| periodontal | clinical/anatomy | IPA | ˌper.i.oʊˈdɑːn.t̬əl | Cambridge US | high | verified, v2 listening PASS |
| periapical | clinical/anatomy | alias | unchanged | none established | unverified | suggested |
| interproximal | clinical/anatomy | alias | unchanged | none established | unverified | suggested |
| edentulous | clinical/anatomy | alias | unchanged | none established | unverified | suggested |
| CBCT | imaging/technology | alias | see bee see tee | ADA terminology plus explicit curated initialism reading | QA correction | verified, v2 listening PASS |
| cephalometric | imaging/technology | alias | unchanged | none established | unverified | suggested |
| CAD/CAM | imaging/technology | alias | cad cam | none established | unverified | suggested |
| intraoral scanner | imaging/technology | alias | unchanged | none established | unverified | suggested |
| panoramic | imaging/technology | alias | unchanged | none established | unverified | suggested |
| bitewing | imaging/technology | alias | unchanged | none established | unverified | suggested |
| prophylaxis | procedures/materials | IPA | ˌ\|p\|r\|oʊ\|f\|ɪ\|ˈ\|l\|æ\|k\|s\|ɪ\|s | Cambridge US; Tavus pipe-delimited format | high | verified, v3 listening PASS |
| scaling and root planing | procedures/materials | alias | unchanged | none established | unverified | suggested |
| pulpotomy | procedures/materials | alias | unchanged | none established | unverified | suggested |
| pulpectomy | procedures/materials | alias | unchanged | none established | unverified | suggested |
| endodontic therapy | procedures/materials | alias | unchanged | none established | unverified | suggested |
| composite | procedures/materials | alias | unchanged | none established | unverified | suggested |
| amalgam | procedures/materials | alias | unchanged | none established | unverified | suggested |
| zirconia | procedures/materials | alias | unchanged | none established | unverified | suggested |
| porcelain-fused-to-metal | procedures/materials | alias | porcelain fused to metal | none established | unverified | suggested |
| Invisalign | orthodontic/specialty | alias | unchanged | no manufacturer pronunciation established | unverified | suggested |
| aligners | orthodontic/specialty | alias | unchanged | none established | unverified | suggested |
| cephalometric tracing | orthodontic/specialty | alias | unchanged | none established | unverified | suggested |
| Open Dental | software/operations | alias | unchanged | absent from current QA dental roles | unverified | suggested |
| Dentrix | software/operations | alias | unchanged | absent from current QA dental roles | unverified | suggested |
| Eaglesoft | software/operations | alias | unchanged | absent from current QA dental roles | unverified | suggested |
| Curve | software/operations | alias | unchanged | absent from current QA dental roles; discover only from explicitly approved client terminology to avoid the common noun | unverified | suggested |

## Evidence links

- Merriam-Webster: endodontics, periodontics, prosthodontics, orthodontics, and periodontal.
- National Cancer Institute Dictionary of Cancer Terms: xerostomia, gingiva, and prophylaxis.
- American Dental Association: the professional term “cone-beam computed tomography (CBCT)”; the registry explicitly stores the selected initialism reading instead of delegating it to TTS defaults.

Exact evidence URLs are stored in the controlled seed metadata. Human listening
remains mandatory: lexical evidence and Grok review do not establish that a
specific Tavus TTS engine/voice renders an alias acceptably.

## Scope and scaling decisions

- No global seed was justified. Normal English and the product name are left to
  the provider until a reproducible failure is observed.
- P1 compiles one bounded resolved QA dental dictionary because Tavus currently
  permits only one pronunciation dictionary on a PAL. Client-scoped records can
  override industry/global records internally without provisioning a dictionary
  per tenant.
- AI and role discovery output is always `suggested`; it cannot enter the
  runtime dictionary until a trusted review changes its status.
- Personal-name fields are not scanned. A spelling is never treated as consent
  or evidence for a person's pronunciation.

## Human listening checklist

For each verified term, listen to the canonical sentence in
`test/fixtures/dental-pronunciation-corpus.json` and record `PASS`, `FAIL`, or
`UNCERTAIN`. Any failure requires an alias/IPA correction, version increment,
resynchronization, and a targeted replay. `UNCERTAIN` is not a pass.

### QA listening correction history

The owner judged all nine v1 alias renderings `FAIL`: the capitalized,
hyphenated respellings were segmented unnaturally, stressed incorrectly, or
spelled as letters. The v2 correction changed eight lexical terms to continuous
US IPA and CBCT to the literal lowercase spoken phrase `see bee see tee`.

The owner judged six v2 renderings `PASS`: endodontics, periodontics,
prosthodontics, xerostomia, periodontal, and CBCT. Orthodontics and prophylaxis
rendered the long-o phoneme as “oo”; gingiva rendered its second short-i phoneme
as “ee.” The targeted v3 correction preserves the lexical IPA evidence while
using Tavus's documented pipe-delimited IPA form to make each intended phoneme
boundary explicit. The owner then judged the v3 orthodontics and prophylaxis
renderings `PASS`, but gingiva still rendered its second short-i as “ee.” The
v4 gingiva-only correction moves the primary stress marker directly before its
first vowel, matching Cartesia's documented placement requirement while leaving
both short-i phones as `ɪ`. The owner judged v4 close but still incorrect: the
second vowel remained “ee.” A short owner reference was captured locally and
was not uploaded or committed. Because repeated IPA variants produced the same
provider error, v5 uses the single continuous lowercase alias `jinjivuh` to
encode both short-i sounds without the segmented capitalized respelling that
failed in v1. The owner judged the v5 one-term replay `PASS`. Final critical
corpus acceptance is 9/9 PASS, 0 FAIL, and 0 UNCERTAIN.
