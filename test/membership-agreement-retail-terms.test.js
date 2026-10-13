'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {buildMembershipAgreementHtml,normalizeMembershipAgreementInput}=require('../src/render/membershipAgreement');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const MARKER='membership_agreement_retail_terms_v2';
const payload={client_legal_name:'[SYNTHETIC] Harbor Maple QA',dba_trade_name:'Harbor Maple Demo',primary_admin_name:'Synthetic Buyer',
  admin_email:'synthetic@example.invalid',membership_tier:'basic',billing_option:'monthly',auto_renew:true,
  term_start_basis:'successful_payment',initial_term_start:'2026-10-12',initial_renewal_date:'2027-10-12'};
const options={generatedAt:'2026-10-12T12:00:00.000Z',timeZone:'UTC'};
function pkg(plan,months,payment,role=false){return buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,
  paymentOption:payment,channel:'sales',firstRolePrepaySelected:role,offerVersion:OFFER_VERSION});}
const plain=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

test('all 24 selected retail variants render trusted prices, terms, obligations and caps',()=>{
  for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true]){
    const snapshot=pkg(plan,months,payment,role);
    const {html,normalized}=buildMembershipAgreementHtml({...payload,membership_tier:plan,
      billing_option:snapshot.billing_cadence,platform_fee:snapshot.platform_fee,per_role_fee:snapshot.per_role_fee,additional_interview_fee:snapshot.additional_interview_fee},
      {...options,packageSnapshot:snapshot});
    const text=plain(html);
    assert.equal(normalized.commitment_months,months);assert.equal(normalized.payment_option,payment);
    assert.equal(normalized.pricing_version,OFFER_VERSION);assert.equal(normalized.billing_option,snapshot.billing_cadence);
    assert.equal(normalized.term_start_basis,'successful_payment');
    assert.match(text,new RegExp(`initial term of ${months} calendar months`));
    assert.match(text,new RegExp(`successive ${months}-month terms`));
    assert.match(text,/at any time before the renewal date/);assert.match(text,/reminder is not a cancellation deadline/);
    assert.match(text,/accepted pricing/);assert.match(text,/successful initial payment/);
    assert.doesNotMatch(text,/at least 30 days|canceled 30 days|this is a 12-month Membership term/);
    if(months!==12)assert.doesNotMatch(text,/12-month commitment/);
    assert.match(text,/Scored Questions/);assert.match(text,/twelve \(12\) months immediately preceding/);
    assert.match(text,new RegExp(`\\$${snapshot.platform_fee.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
    if(payment==='monthly_installments')assert.match(text,/remaining installment payments/);
    else assert.match(text,/full prepaid term/);
    if(role)assert.match(text,/First-Role Prepay Credit/);
    else assert.doesNotMatch(text,/First-Role Prepay Credit/);
  }
});

test('trusted accepted historical price is not replaced by current catalog',()=>{
  const s=structuredClone(pkg('basic',3,'prepaid'));
  s.platform_fee=1100;s.platform_fee_cents=110000;s.platform_commitment_total_cents=110000;
  s.membership_terms.platform_payment_cents=110000;s.membership_terms.platform_commitment_total_cents=110000;s.membership_terms.initial_payment_cents=110000;
  const {html}=buildMembershipAgreementHtml({...payload,billing_option:'prepaid'},{...options,packageSnapshot:s});
  assert.match(html,/\$1,100\.00/);assert.doesNotMatch(html,/\$1,200\.00/);
});

test('installment total is a commitment total, not the initial amount due',()=>{
  const s=pkg('basic',3,'monthly_installments',true);
  const {html}=buildMembershipAgreementHtml(payload,{...options,packageSnapshot:s});
  const text=plain(html);assert.match(text,/Platform Commitment Total.*\$1,347\.00/);
  assert.match(text,/Initial Amount Due.*\$808\.00/);
  assert.match(text,/one-time/);assert.match(text,/does not expire/);
});

test('mismatched supplied new selections and malformed snapshots cannot render a relabeled old agreement',()=>{
  const s=pkg('basic',3,'prepaid');
  for(const change of [{membership_tier:'pro'},{commitment_months:6},{payment_option:'monthly_installments'},
    {pricing_version:'different'},{auto_renew:false},{auto_renew:null},{billing_option:'annual'},{platform_fee:'0.01'},
    {per_role_fee:'0.01'},{included_interviews_per_role:999},{max_interview_minutes:99},{scored_question_count:7},
    {billing_model:'usage'},{rollover_days:90},{first_role_prepay:{selected:true,amount_cents:1}}])
    assert.throws(()=>buildMembershipAgreementHtml({...payload,billing_option:'prepaid',...change},{...options,packageSnapshot:s}),/retail_agreement_terms_mismatch/);
  const bad=structuredClone(s);bad.membership_terms.commitment_months=9;
  assert.throws(()=>buildMembershipAgreementHtml(payload,{...options,packageSnapshot:bad}),/invalid_retail_package_terms/);
});

test('raw payload cannot select the new legal variant, and party data stays HTML escaped',()=>{
  const s=pkg('basic',3,'prepaid');
  const old=buildMembershipAgreementHtml({...payload,package_snapshot:s},options);
  assert.match(old.html,/12-month Membership term/);assert.equal(old.normalized.commitment_months,undefined);
  const escaped=buildMembershipAgreementHtml({...payload,billing_option:'prepaid',client_legal_name:'<script>evil()</script>'},{...options,packageSnapshot:s});
  assert.match(escaped.html,/&lt;script&gt;evil\(\)&lt;\/script&gt;/);assert.doesNotMatch(escaped.html,/<script>/);
});

test('omitted fields do not become conflicts through legacy normalizer defaults',()=>{
  const snapshot=pkg('pro',6,'prepaid');
  const {html,normalized}=buildMembershipAgreementHtml({client_legal_name:payload.client_legal_name},
    {...options,showPackageTerms:false,packageSnapshot:snapshot});
  assert.equal(normalized.billing_option,'prepaid');assert.equal(normalized.membership_tier,'pro');
  assert.match(html,/Platform Fee/);assert.match(html,/Scored Questions/);assert.match(html,/\$3,600\.00/);
});

test('legacy retail and Enterprise HTML remains byte-identical to reviewed pre-adaptation source',()=>{
  const root=path.resolve(__dirname,'..'),filename=path.join(root,'src/render/membershipAgreement.js');
  const oldSource=execFileSync('git',['show','4fb6ea3dd1ee2991b54608d1da68fdc0548684ef:src/render/membershipAgreement.js'],{cwd:root,encoding:'utf8'});
  const oldTemplate=execFileSync('git',['show','4fb6ea3dd1ee2991b54608d1da68fdc0548684ef:templates/pdf/membership-agreement.hbs'],{cwd:root,encoding:'utf8'});
  const originalFs=require('node:fs'),scopedRequire=createRequire(filename),module={exports:{}};
  const oldFs=new Proxy(originalFs,{get(target,key){if(key==='readFileSync')return(file,...args)=>String(file)===path.join(root,'templates/pdf/membership-agreement.hbs')?oldTemplate:target.readFileSync(file,...args);return target[key];}});
  vm.runInNewContext(oldSource,{require:name=>name==='fs'?oldFs:scopedRequire(name),module,exports:module.exports,
    __dirname:path.dirname(filename),Buffer,process,console},{filename});
  for(const legacy of [payload,{...payload,billing_option:'annual'},
    {...payload,membership_tier:'enterprise',platform_fee:499,per_role_fee:699,included_interviews_per_role:50,additional_interview_fee:25,billing_model:'rollover',rollover_days:90}]) {
    assert.deepEqual(normalizeMembershipAgreementInput(legacy),JSON.parse(JSON.stringify(module.exports.normalizeMembershipAgreementInput(legacy))));
    assert.equal(buildMembershipAgreementHtml(legacy,{...options,showPackageTerms:true}).html,
      module.exports.buildMembershipAgreementHtml(legacy,{...options,showPackageTerms:true}).html);
  }
});

test('executed new agreement loads the saved trusted snapshot and refuses conflicting legal markers',()=>{
  const supabasePath=require.resolve('../src/clients/supabase');
  require.cache[supabasePath]={id:supabasePath,filename:supabasePath,loaded:true,exports:{supabaseAdmin:{}}};
  const {buildExecutedMembershipAgreementHtml}=require('../src/services/membershipAgreements');
  const s=pkg('pro',6,'prepaid'),row={membership_tier:'pro',billing_option:'prepaid',template_version:MARKER,
    template_snapshot:{template_version:MARKER,generated_at:options.generatedAt,package_snapshot:s,
      values:normalizeMembershipAgreementInput({...payload,membership_tier:'pro',billing_option:'prepaid'}, {packageSnapshot:s})}};
  const {html}=buildExecutedMembershipAgreementHtml(row,{accepted:true,signer_typed_name:'Synthetic Buyer',signed_at:options.generatedAt});
  assert.match(plain(html),/initial term of 6 calendar months/);assert.match(html,/Signed on/);
  assert.throws(()=>buildExecutedMembershipAgreementHtml({...row,template_version:'legacy'},{}),/retail_agreement_terms_mismatch/);
  assert.throws(()=>buildExecutedMembershipAgreementHtml({...row,template_snapshot:{...row.template_snapshot,package_snapshot:null}},{}),/retail_agreement_terms_mismatch/);
});
