'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {test}=require('node:test');
const {TEMPLATE_VERSION,createRetailMembershipReviewService,verifyReviewBundleIntegrity}=require('../src/render/retailMembershipReview');
const {fixture,canonical,sha}=require('./fixtures/retail-review-fixture');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const fakePdf=()=>Buffer.from('%PDF-1.7\nSYNTHETIC-UNIT-TEST-ONLY\n%%EOF');
function service(f,extra={}){return createRetailMembershipReviewService({
  loadSource:async(subject,id)=>{assert.equal(subject,'synthetic auth');assert.equal(id,f.sourceId);return f.sourceReply;},
  loadQuote:async(subject,id)=>{assert.equal(subject,'synthetic auth');assert.equal(id,f.sourceReply.source.quote_id);return f.quoteReply;},
  renderPdf:async()=>fakePdf(),preparedAt:()=> '2026-10-11T12:01:00.000Z',...extra});}
const prepare=(f,extra)=>service(f,extra).prepare('synthetic auth',{sourceId:f.sourceId});
function text(html){return html.replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
function amounts(v){return `$${(BigInt(v)/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${(BigInt(v)%100n).toString().padStart(2,'0')}`;}
test('explicit server loaders/PDF renderer mandatory; no default authorization or effects',()=>{
  assert.throws(()=>createRetailMembershipReviewService(),e=>e.code==='retail_review_not_configured');
  assert.throws(()=>createRetailMembershipReviewService({loadSource:async()=>({}),loadQuote:async()=>({})}),e=>e.code==='retail_review_not_configured');
});
test('all24 offer/term/schedule/first-role choices preserve source amounts and draft-only flags',async()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments'])for(const firstRolePrepaySelected of [false,true]){
    const f=fixture({planKey,commitmentMonths,paymentOption,firstRolePrepaySelected}),o=f.quoteReply.quote.offer,r=await prepare(f),t=text(r.html);
    for(const v of [o.platform_payment_cents,o.platform_commitment_total_cents,o.initial_payment_cents,o.per_role_fee_cents,o.additional_interview_fee_cents])assert.ok(t.includes(amounts(v)));
    assert.ok(t.includes(`${commitmentMonths}-month commitment`));
    if(paymentOption==='prepaid')assert.ok(t.includes(`${amounts(o.platform_payment_cents)} prepaid for the full ${commitmentMonths}-month term`));
    else assert.ok(t.includes(`${o.installment_count} monthly installments of ${amounts(o.platform_payment_cents)}`));
    assert.ok(t.includes(firstRolePrepaySelected?`${amounts(o.first_role_prepay.amount_cents)} - selected`:'Not selected'));
    assert.equal(r.manifest.publication,'draft_only');assert.equal(r.manifest.refund_policy_reference,null);
    assert.equal(r.manifest.signing_enabled,false);assert.equal(r.manifest.send_enabled,false);assert.equal(r.manifest.checkout_enabled,false);
    assert.deepEqual(r.manifest.snapshot.quote.offer,o);assert.equal(r.manifest.snapshot.source_fingerprint,f.sourceReply.source_fingerprint);
    assert.equal(verifyReviewBundleIntegrity(r),true);
  }
});
test('monthly full obligation, successful-payment basis and strict renewal cutoff print correctly',async()=>{
  const f=fixture({planKey:'pro',commitmentMonths:6,paymentOption:'monthly_installments'}),r=await prepare(f),t=text(r.html);
  assert.match(t,/6 monthly installments of \$699\.00/);assert.match(t,/total platform commitment of \$4,194\.00/);
  assert.match(t,/Auto-renewal is enabled by default/);assert.match(t,/before the current term ends/);
  assert.match(t,/reminder is not a cancellation deadline/);assert.match(t,/not forgive remaining installments/);
  assert.match(t,/full initial payment/);assert.doesNotMatch(t,/written notice at least 30 days|twelve \(12\) month renewal terms|One year after initial payment/);
  const term=r.html.match(/id="membership-term"[\s\S]*?<\/div>/)[0];assert.doesNotMatch(term,/12-month|2027|2026/);
  assert.match(t,/twelve \(12\) months immediately preceding/, 'liability lookback unchanged');
});
test('prepaid/first-role/rollover are separate and accepted future-price snapshots are not repriced',async()=>{
  const f=fixture({planKey:'pro',commitmentMonths:12,firstRolePrepaySelected:true});
  const o=structuredClone(f.quoteReply.quote.offer);o.offer_version='future-accepted-price-test';o.platform_payment_cents=650001;
  o.platform_commitment_total_cents=650001;o.initial_payment_cents=650001+o.first_role_prepay.amount_cents;f.quoteReply.quote.offer=o;f.rehash();
  const r=await prepare(f),t=text(r.html);assert.match(t,/\$6,500\.01 prepaid for the full 12-month term/);
  assert.match(t,/\$629\.00/);assert.match(t,/not charged again on renewal/);assert.match(t,/90 days from that close/);
  assert.match(t,/earliest expiration/);assert.equal(r.manifest.snapshot.quote.offer.platform_payment_cents,650001);
});
test('client text escaped and long Unicode text survives; remote/executable HTML absent',async()=>{
  const f=fixture({}, {company_legal_name:'Café & O\'Brien "Research" '.repeat(5).trim(),buyer_first_name:'Zoë',buyer_last_name:'López'}),r=await prepare(f);
  assert.match(r.html,/Café &amp; O&#x27;Brien &quot;Research&quot;/);assert.match(r.html,/Zoë López/);
  assert.doesNotMatch(r.html,/<script|<form|https?:\/\/|file:\/\/|@import/i);assert.match(r.html,/data:font\/ttf;base64/);assert.match(r.html,/data:image\/png;base64/);
  assert.equal(r.manifest.snapshot.source.buyer.company_legal_name,f.sourceReply.source.buyer.company_legal_name);
});
test('browser buyer/money/actor/policy/signature/publication/clock fields rejected before loaders',async()=>{
  let calls=0;const f=fixture(),s=service(f,{loadSource:async()=>{calls++;return f.sourceReply;}});
  for(const key of ['buyer','amount','quoteId','issuer_user_id','refund_policy_reference','signature','publication','preparedAt','template'])
    await assert.rejects(()=>s.prepare('synthetic auth',{sourceId:f.sourceId,[key]:'forged'}),e=>e.code==='invalid_retail_review_request');
  await assert.rejects(()=>s.prepare('synthetic auth',{}),e=>e.code==='invalid_retail_review_request');assert.equal(calls,0);
});
test('cross source/quote/scope/rep/client/billing owner and unsupported protocol never render',async()=>{
  for(const mutate of [f=>f.sourceReply.source.source_id=crypto.randomUUID(),f=>f.quoteReply.quote.quote_id=crypto.randomUUID(),
    f=>f.quoteReply.quote.scope_id=crypto.randomUUID(),f=>f.quoteReply.quote.issuer_user_id=crypto.randomUUID(),
    f=>f.quoteReply.quote.original_salesperson_user_id=crypto.randomUUID(),f=>f.quoteReply.quote.client_id=crypto.randomUUID(),
    f=>f.quoteReply.quote.billing_owner_user_id=crypto.randomUUID(),f=>f.quoteReply.quote.audience='admin',f=>f.sourceReply.source.protocol='sales_assisted',
    f=>f.quoteReply.quote.template_version='unapproved',f=>f.sourceReply.source.acceptance_state='signed',f=>f.quoteReply.quote.signing_source_bound=true,
    f=>f.sourceReply.source.unreviewed_field=true,f=>f.quoteReply.quote.unreviewed_field=true,f=>f.quoteReply.quote.expires_at='2026-02-30T12:00:00.000Z']){
    const f=fixture();mutate(f);f.rehash();let renders=0;
    await assert.rejects(()=>prepare(f,{renderPdf:async()=>{renders++;return fakePdf();}}),e=>e.code==='retail_review_unverified');assert.equal(renders,0);
  }
});
test('invalid digest or offer invariants cannot print plausible but incorrect financial terms',async()=>{
  for(const mutate of [f=>f.sourceReply.source_fingerprint='a'.repeat(64),f=>f.quoteReply.quote_digest='b'.repeat(64),
    f=>f.quoteReply.quote.offer.platform_commitment_total_cents=1,f=>f.quoteReply.quote.offer.initial_payment_cents=1,
    f=>f.quoteReply.quote.offer.platform_payment_cents=Number.MAX_SAFE_INTEGER+1,f=>f.quoteReply.quote.offer.currency='eur',
    f=>f.quoteReply.quote.offer.commitment_months=9,f=>f.quoteReply.quote.offer.renewal.non_renewal_cutoff='30_days_prior',
    f=>f.quoteReply.quote.offer.first_role_prepay.amount_cents=99,f=>f.quoteReply.quote.offer.plan_key='enterprise']){
    const f=fixture();f.quoteReply.quote.offer=structuredClone(f.quoteReply.quote.offer);mutate(f);
    if(!/^([ab])\1{63}$/.test(f.sourceReply.source_fingerprint)&&!/^([ab])\1{63}$/.test(f.quoteReply.quote_digest))f.rehash();
    await assert.rejects(()=>prepare(f),e=>e.code==='retail_review_unverified');
  }
});
test('malformed buyer, pending legal state, stale/expired and enabled effects are held',async()=>{
  for(const mutate of [f=>f.sourceReply.source.buyer.buyer_first_name='<script>',f=>f.sourceReply.source.buyer.buyer_email='a\nb@example.invalid',
    f=>f.sourceReply.source.buyer.buyer_email='UPPER@example.invalid',f=>f.sourceReply.source.buyer.client_id=crypto.randomUUID(),
    f=>f.quoteReply.stale=true,f=>f.quoteReply.expired=true,f=>f.quoteReply.signing_enabled=true,f=>f.sourceReply.signing_enabled=true,
    f=>f.sourceReply.checkout_enabled=true,f=>f.quoteReply.quote.template_status='published']){
    const f=fixture();mutate(f);f.rehash();await assert.rejects(()=>prepare(f),e=>e.code==='retail_review_unverified');
  }
});
test('late replacement/staleness/expiry/authorization error holds generated PDF without returning a bundle',async()=>{
  for(const mode of ['replace','stale','expire','revoke']){
    const f=fixture();let late=false;
    await assert.rejects(()=>prepare(f,{renderPdf:async()=>{late=true;if(mode==='replace'){f.sourceReply.source.buyer.buyer_first_name='Changed';f.rehash();}
      if(mode==='stale')f.quoteReply.stale=true;if(mode==='expire')f.quoteReply.expired=true;return fakePdf();},
      loadSource:async()=>{if(late && mode==='revoke')throw new Error('secret token synthetic');return f.sourceReply;}}),e=>
        e.code===({replace:'retail_review_changed',stale:'retail_review_unverified',expire:'retail_review_unverified',revoke:'retail_review_scope_unavailable'}[mode]) && !e.message.includes('secret'));
  }
});
test('loader and renderer errors are sanitized; malformed/oversized PDF results rejected',async()=>{
  const f=fixture();await assert.rejects(()=>prepare(f,{loadSource:async()=>{throw new Error('private_auth_token');}}),e=>e.code==='retail_review_scope_unavailable');
  await assert.rejects(()=>prepare(f,{renderPdf:async()=>{throw new Error('private_render_detail');}}),e=>e.code==='retail_review_render_failed');
  for(const bad of [null,'plain string',Buffer.from('not PDF'),Buffer.from('%PDF-1.7 without end marker'),Buffer.alloc(8*1024*1024+1)])
    await assert.rejects(()=>prepare(f,{renderPdf:async()=>bad}),e=>e.code==='retail_review_pdf_invalid');
});
test('manifest full snapshot/template/assets/profile hashes fixed; mutable bytes copied and tampering detected',async()=>{
  const f=fixture(),bytes=fakePdf(),r=await prepare(f,{renderPdf:async()=>bytes});
  assert.ok(Object.isFrozen(r.manifest));assert.ok(Object.isFrozen(r.manifest.snapshot.source.buyer));assert.ok(Object.isFrozen(r.manifest.render_profile));
  assert.equal(r.manifest_canonical,canonical(r.manifest));assert.equal(r.manifest_digest,sha(r.manifest_canonical));
  assert.equal(r.manifest.template_version,TEMPLATE_VERSION);assert.match(r.manifest.template_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(r.manifest.asset_sha256),['logo','regular','bold']);
  bytes.fill(0);assert.equal(verifyReviewBundleIntegrity(r),true);r.pdf_bytes.fill(0);assert.equal(verifyReviewBundleIntegrity(r),false);
  const fresh=await prepare(f);assert.equal(verifyReviewBundleIntegrity({...fresh,html:fresh.html+'changed'}),false);
  const m=structuredClone(fresh.manifest);m.snapshot.quote.offer.platform_payment_cents=1;assert.equal(verifyReviewBundleIntegrity({...fresh,manifest:m}),false);
});
test('bundle integrity is not authenticity; a rehashed copy never authorizes an effect',async()=>{
  const r=await prepare(fixture()),manifest=structuredClone(r.manifest),html=r.html.replace('Your membership details','Changed review header');
  manifest.html_sha256=sha(html);const manifest_canonical=canonical(manifest);
  assert.equal(verifyReviewBundleIntegrity({...r,manifest,html,manifest_canonical,manifest_digest:sha(manifest_canonical)}),true);
  assert.equal(manifest.signing_enabled,false);assert.equal(manifest.send_enabled,false);
  manifest.signing_enabled=true;const altered=canonical(manifest);
  assert.equal(verifyReviewBundleIntegrity({...r,manifest,html,manifest_canonical:altered,manifest_digest:sha(altered)}),false);
});
test('unique review IDs, legal policy hold, no actual paid/signature dates; input clocks strictly controlled',async()=>{
  const f=fixture(),a=await prepare(f),b=await prepare(f);assert.notEqual(a.manifest.document_id,b.manifest.document_id);
  assert.equal(a.manifest.refund_policy_reference,null);assert.match(text(a.html),/final publication pending/);
  assert.doesNotMatch(a.html,/<input|signature_image|checkout_session/);
  for(const instant of ['2026-02-30T12:00:00.000Z','0000-10-11T12:00:00.000Z','2026-10-11','bad'])
    await assert.rejects(()=>prepare(f,{preparedAt:()=>instant}),e=>e.code==='retail_review_clock_invalid');
});
test('existing boilerplate unchanged for clauses1,4-14 and first2 General paragraphs; legacy/Enterprise renderer still original',async()=>{
  const old=fs.readFileSync(path.join(__dirname,'../templates/pdf/membership-agreement.hbs'),'utf8'),r=await prepare(fixture());
  for(const n of [1,4,5,6,7,8,9,10,11,12,13,14]){
    const section=old.slice(old.indexOf(`>${n}. `),old.indexOf(`>${n+1}. `));
    const paras=[...section.matchAll(/<p class="section-paragraph">([\s\S]*?)<\/p>/g)].map(m=>m[1]);
    const next=r.html.match(new RegExp(`data-clause="${n}"[\\s\\S]*?<\\/div>`))[0];
    paras.forEach(p=>assert.ok(next.includes(p),`unchanged clause${n}`));
  }
  const legacy=buildMembershipAgreementHtml({client_legal_name:'Legacy Synthetic',membership_tier:'pro',billing_option:'monthly',initial_term_start:'2026-01-01',initial_renewal_date:'2027-01-01'},{generatedAt:'2026-10-11T00:00:00Z'}).html;
  const general=old.slice(old.indexOf('>15. General'));
  const paragraphs=[...general.matchAll(/<p class="section-paragraph">([\s\S]*?)<\/p>/g)].slice(0,2).map(m=>m[1]);
  paragraphs.forEach(p=>assert.ok(r.html.includes(p),'General original first2 paragraphs'));
  assert.match(legacy,/initial term of twelve \(12\) months|initial renewal date/);assert.match(legacy,/at least 30 days/);
  const enterprise=buildMembershipAgreementHtml({client_legal_name:'Enterprise Synthetic',membership_tier:'enterprise',billing_model:'usage',billing_option:'annual',platform_fee:'1000',usage_interview_fee_cents:2500},{generatedAt:'2026-10-11T00:00:00Z'}).html;
  assert.match(enterprise,/Enterprise Commercial Terms/);assert.match(enterprise,/\$25\.00 per interview/);assert.doesNotMatch(enterprise,/REVIEW DRAFT/);
});
test('buyer bidi override/isolate marks are rejected, not silently stripped or rendered as ambiguous identity',async()=>{
  for(const mark of ['\u061c','\u200e','\u200f','\u202a','\u202b','\u202c','\u202d','\u202e','\u2066','\u2067','\u2068','\u2069'])
    for(const field of ['company_legal_name','company_dba','buyer_first_name','buyer_last_name','buyer_title']){
      const f=fixture({}, {[field]:`Synthetic${mark} Identity`});let renderCount=0;
      await assert.rejects(()=>prepare(f,{renderPdf:async()=>{renderCount++;return fakePdf();}}),e=>e.code==='retail_review_unverified');
      assert.equal(renderCount,0);assert.equal(f.sourceReply.source.buyer[field],`Synthetic${mark} Identity`,'no silent normalization/write');
    }
});
