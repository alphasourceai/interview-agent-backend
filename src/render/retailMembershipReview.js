'use strict';

// LOCAL/UNMOUNTED review preparation, NOT legal publication or signing.
// Trusted loaders are the reviewed source/quote services, never browser JSON.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const Handlebars=require('handlebars');
const {TEMPLATE_VERSION:QUOTE_TEMPLATE_VERSION}=require('../services/membershipQuoteDrafts');
const TEMPLATE_VERSION='retail-membership-review-2026-10-11-v1';
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const MAX_HTML=2*1024*1024,MAX_PDF=8*1024*1024;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function canonical(v){if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  return v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);}
function frozen(v){if(v && typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
function fail(code,status=409){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code='retail_review_unverified',status){if(!ok)fail(code,status);}
function plain(v,keys){return v && typeof v==='object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Object.keys(v).every(k=>keys.includes(k));}
function bounded(text,limit){return typeof text==='string' && text.length>0 && [...text].length<=limit
  && text===text.trim() && !/[\p{Cc}\p{Cs}<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text);}
function cents(v){check(Number.isSafeInteger(v) && v>=0);const n=BigInt(v);
  return `$${(n/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${(n%100n).toString().padStart(2,'0')}`;}
function safeOffer(o){
  const keys=['schema_version','offer_version','offer_key','plan_key','display_name','currency','commitment_months',
    'term_start_basis','contract_timezone','payment_option','platform_payment_cents','platform_commitment_total_cents',
    'installment_count','stripe_recurrence','initial_payment_cents','per_role_fee_cents','additional_interview_fee_cents',
    'included_interviews_per_role','max_interview_minutes','scored_question_count','billing_model','rollover_days','first_role_prepay','renewal'];
  check(plain(o,keys) && Object.keys(o).length===keys.length && o.schema_version===2 && bounded(o.offer_version,100) && bounded(o.offer_key,100)
    && bounded(o.display_name,100) && ['basic','pro'].includes(o.plan_key) && o.currency==='usd'
    && [3,6,12].includes(o.commitment_months) && ['prepaid','monthly_installments'].includes(o.payment_option)
    && o.term_start_basis==='first_payment_success' && o.contract_timezone==='UTC');
  for(const key of ['platform_payment_cents','platform_commitment_total_cents','initial_payment_cents',
    'per_role_fee_cents','additional_interview_fee_cents','included_interviews_per_role','max_interview_minutes','scored_question_count'])
    check(Number.isSafeInteger(o[key]) && o[key]>0);
  const installment=o.payment_option==='monthly_installments',role=o.first_role_prepay,r=o.renewal;
  check(plain(role,['selected','amount_cents','normal_role_fee_cents','credit_type','expires','non_refundable']) && Object.keys(role).length===6
    && plain(r,['default_auto_renew','commitment_months','retain_accepted_pricing','reminder_days','non_renewal_cutoff','ends_installments_early']) && Object.keys(r).length===6
    && plain(o.stripe_recurrence,['interval','interval_count']) && Object.keys(o.stripe_recurrence).length===2);
  check(o.installment_count===(installment?o.commitment_months:1)
    && BigInt(o.platform_commitment_total_cents)===BigInt(o.platform_payment_cents)*BigInt(o.installment_count)
    && o.stripe_recurrence?.interval==='month' && o.stripe_recurrence.interval_count===(installment?1:o.commitment_months)
    && role && typeof role.selected==='boolean' && Number.isSafeInteger(role.amount_cents) && role.amount_cents>=0
    && (role.selected?role.amount_cents>0:role.amount_cents===0) && role.normal_role_fee_cents===o.per_role_fee_cents
    && role.credit_type==='first_role_prepay' && role.expires===false && role.non_refundable===true
    && BigInt(o.initial_payment_cents)===BigInt(o.platform_payment_cents)+BigInt(role.amount_cents)
    && o.max_interview_minutes>=5 && o.max_interview_minutes<=59 && o.scored_question_count>=1 && o.scored_question_count<=7
    && ((o.billing_model==='fixed' && o.rollover_days===null) || (o.billing_model==='rollover'
      && Number.isSafeInteger(o.rollover_days) && o.rollover_days>=1 && o.rollover_days<=3650))
    && r?.default_auto_renew===true && r.commitment_months===o.commitment_months && r.retain_accepted_pricing===true
    && r.reminder_days===30 && r.non_renewal_cutoff==='before_term_end' && r.ends_installments_early===false);
}
function verifyPair(sourceReply,quoteReply,id){
  const s=sourceReply?.source,q=quoteReply?.quote,b=s?.buyer;
  check(plain(sourceReply,['source','source_fingerprint','email_verified','verified_at','signing_enabled','checkout_enabled']) && Object.keys(sourceReply).length===6
    && plain(quoteReply,['quote','quote_digest','expired','stale','signing_enabled']) && Object.keys(quoteReply).length===5
    && plain(s,['protocol','source_version','source_id','scope_id','issuer_user_id','original_salesperson_user_id','quote_id','quote_digest','previous_source_id','buyer','acceptance_state']) && Object.keys(s).length===11
    && plain(q,['schema_version','protocol','quote_id','scope_id','audience','issuer_user_id','original_salesperson_user_id','client_id','billing_owner_user_id',
      'acceptance_state','signing_source_bound','offer','template_version','template_status','issued_at','expires_at']) && Object.keys(q).length===16);
  check(sourceReply?.signing_enabled===false && sourceReply.checkout_enabled===false && typeof sourceReply.email_verified==='boolean'
    && (sourceReply.email_verified?typeof sourceReply.verified_at==='string' && Number.isFinite(Date.parse(sourceReply.verified_at)):sourceReply.verified_at===null));
  check(s && s.protocol==='retail_sales_prospect_v2' && s.source_version===1 && s.acceptance_state==='unsigned'
    && s.source_id===id && UUID.test(s.source_id) && UUID.test(s.scope_id) && UUID.test(s.issuer_user_id)
    && s.original_salesperson_user_id===s.issuer_user_id && UUID.test(s.quote_id)
    && (s.previous_source_id===null || UUID.test(s.previous_source_id)) && HASH.test(s.quote_digest)
    && HASH.test(sourceReply.source_fingerprint) && sha(canonical(s))===sourceReply.source_fingerprint);
  const keys=['company_legal_name','company_dba','buyer_first_name','buyer_last_name','buyer_email','buyer_phone','buyer_title'];
  check(plain(b,keys) && Object.keys(b).length===7 && bounded(b.company_legal_name,160)
    && bounded(b.buyer_first_name,80) && bounded(b.buyer_last_name,80) && bounded(b.buyer_email,254)
    && b.buyer_email===b.buyer_email.toLowerCase() && /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(b.buyer_email)
    && !/\.\.|\.@/.test(b.buyer_email)
    && (b.company_dba===null || bounded(b.company_dba,160)) && (b.buyer_title===null || bounded(b.buyer_title,120))
    && (b.buyer_phone===null || (typeof b.buyer_phone==='string' && /^\+[1-9][0-9]{7,14}$/.test(b.buyer_phone))));
  check(q && quoteReply.expired===false && quoteReply.stale===false && quoteReply.signing_enabled===false
    && q.schema_version===2 && q.protocol==='retail_quote_draft_v2' && q.acceptance_state==='unsigned'
    && q.signing_source_bound===false && q.quote_id===s.quote_id && q.scope_id===s.scope_id && q.audience==='sales'
    && q.issuer_user_id===s.issuer_user_id && q.original_salesperson_user_id===s.original_salesperson_user_id
    && q.client_id===null && q.billing_owner_user_id===null && q.template_version===QUOTE_TEMPLATE_VERSION && q.template_status==='draft_only'
    && HASH.test(quoteReply.quote_digest) && quoteReply.quote_digest===s.quote_digest && sha(canonical(q))===quoteReply.quote_digest);
  safeOffer(q.offer);
  for(const instant of [q.issued_at,q.expires_at])check(typeof instant==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)
    && instant.slice(0,4)!=='0000' && Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString()===instant);
  check(Date.parse(q.expires_at)-Date.parse(q.issued_at)===30*60000);
  return frozen({source:structuredClone(s),source_fingerprint:sourceReply.source_fingerprint,
    email_verified:sourceReply.email_verified,verified_at:sourceReply.verified_at,quote:structuredClone(q),quote_digest:quoteReply.quote_digest});
}

// Fixed packaged assets only. No caller path, env logo override or remote font.
const root=path.join(__dirname,'../../templates');
const templateBytes=fs.readFileSync(path.join(root,'pdf/retail-membership-review-v1.hbs'));
const assetFiles={logo:'pdf/assets/No bg - color logo - dark text.png',
  regular:'email-attachments/alphascreen-getting-started-playbook-source/fonts/Raleway-Regular.ttf',
  bold:'email-attachments/alphascreen-getting-started-playbook-source/fonts/Raleway-Bold.ttf'};
const assets=Object.fromEntries(Object.entries(assetFiles).map(([k,file])=>[k,fs.readFileSync(path.join(root,file))]));
const assetHashes=frozen(Object.fromEntries(Object.entries(assets).map(([k,bytes])=>[k,sha(bytes)])));
const fontCSS=['regular','bold'].map(k=>`@font-face{font-family:Raleway;font-weight:${k==='bold'?700:400};font-style:normal;src:url(data:font/ttf;base64,${assets[k].toString('base64')}) format('truetype');}`).join('\n');
const template=Handlebars.compile(templateBytes.toString('utf8'),{strict:true});
const RENDER_PROFILE=frozen({format:'Letter',landscape:false,printBackground:true,displayHeaderFooter:true,
  margin:{top:'0.6in',right:'0.6in',bottom:'0.65in',left:'0.6in'},headerTemplate:'<span></span>',
  footerTemplate:'<div style="font-family:Arial,sans-serif;font-size:8px;color:#5d6375;width:100%;padding:0 .6in;display:flex;justify-content:space-between"><span>alphaScreen | REVIEW DRAFT - NOT FOR SIGNATURE</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'});
function renderData(pair,id,preparedAt){const o=pair.quote.offer,b=pair.source.buyer,installments=o.payment_option==='monthly_installments';
  return {font_css:fontCSS,logo_src:`data:image/png;base64,${assets.logo.toString('base64')}`,buyer:b,
    dba_label:b.company_dba || 'None provided',title_label:b.buyer_title || 'None provided',phone_label:b.buyer_phone || 'None provided',
    plan_name:o.display_name,months:o.commitment_months,installments,payment_label:installments?'Monthly installments':'Pay upfront',
    platform_payment:cents(o.platform_payment_cents),platform_total:cents(o.platform_commitment_total_cents),initial_payment:cents(o.initial_payment_cents),
    payment_note:installments?`${o.installment_count} monthly installments`:`Prepaid for ${o.commitment_months} months`,
    first_role_label:o.first_role_prepay.selected?`${cents(o.first_role_prepay.amount_cents)} - selected`:'Not selected',
    first_role_note:o.first_role_prepay.selected?`The one-time first-role prepayment of ${cents(o.first_role_prepay.amount_cents)} is separate from platform membership. It is non-refundable, has no expiration, and applies to the first role opened under the billing entity. Later roles cost ${cents(o.per_role_fee_cents)} each. Membership changes require client success/support review to apply or adjust the credit.`:
      'The first role was not prepaid. The standard per-role fee is charged when a role is opened.',
    per_role_fee:cents(o.per_role_fee_cents),extra_interview_fee:cents(o.additional_interview_fee_cents),
    included_interviews:o.included_interviews_per_role,interview_minutes:o.max_interview_minutes,question_count:o.scored_question_count,
    capacity_note:o.billing_model==='rollover'?`Unused interview capacity is credited when a role closes and stays usable for ${o.rollover_days} days from that close. Credits with the earliest expiration are used first.`:
      'Interview capacity is fixed per role. This plan does not include rollover credit.',
    ack_payment:installments?`All ${o.installment_count} installments remain owed for this term, even if renewal is turned off.`:
      'Paid access remains active for the full prepaid term after payment, even if renewal is turned off.',
    prepared_label:new Date(preparedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}),
    document_id:id,offer_version:o.offer_version,template_version:TEMPLATE_VERSION};
}
function pdfCopy(value){check(Buffer.isBuffer(value)||value instanceof Uint8Array,'retail_review_pdf_invalid',503);
  const bytes=Buffer.from(value);check(bytes.length>=16 && bytes.length<=MAX_PDF && bytes.subarray(0,5).toString('ascii')==='%PDF-'
    && bytes.subarray(-1024).toString('latin1').includes('%%EOF'),'retail_review_pdf_invalid',503);return bytes;}
function createRetailMembershipReviewService({loadSource,loadQuote,renderPdf,preparedAt=()=>new Date().toISOString(),newId=()=>crypto.randomUUID()}={}){
  check(typeof loadSource==='function' && typeof loadQuote==='function' && typeof renderPdf==='function'
    && typeof preparedAt==='function' && typeof newId==='function','retail_review_not_configured',503);
  async function read(subject,id){let sourceReply,quoteReply;
    try{sourceReply=structuredClone(await loadSource(subject,id));quoteReply=structuredClone(await loadQuote(subject,sourceReply?.source?.quote_id));}
    catch(_){fail('retail_review_scope_unavailable',403);}return verifyPair(sourceReply,quoteReply,id);}
  return Object.freeze({async prepare(subject,input){
    check(plain(input,['sourceId']) && Object.hasOwn(input,'sourceId') && typeof input.sourceId==='string' && UUID.test(input.sourceId),'invalid_retail_review_request',400);
    const first=await read(subject,input.sourceId),baseline=canonical(first);let id,instant;
    try{id=newId();instant=preparedAt();}catch(_){fail('retail_review_clock_invalid',503);}
    check(typeof id==='string' && UUID.test(id) && typeof instant==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)
      && instant.slice(0,4)!=='0000' && Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString()===instant,'retail_review_clock_invalid',503);
    const html=template(renderData(structuredClone(first),id,instant));check(Buffer.byteLength(html,'utf8')<=MAX_HTML,'retail_review_html_invalid',503);
    let result;try{result=await renderPdf(html,RENDER_PROFILE);}catch(_){fail('retail_review_render_failed',503);}
    const pdf=pdfCopy(result),after=await read(subject,input.sourceId);
    check(canonical(after)===baseline,'retail_review_changed',409);
    const manifest=frozen({protocol:'retail_agreement_review_bundle_v1',schema_version:1,document_id:id,prepared_at:instant,
      template_version:TEMPLATE_VERSION,template_sha256:sha(templateBytes),asset_sha256:assetHashes,
      publication:'draft_only',refund_policy_reference:null,acceptance_state:'unsigned',signing_enabled:false,send_enabled:false,checkout_enabled:false,
      snapshot:first,render_profile:RENDER_PROFILE,html_sha256:sha(html),pdf_sha256:sha(pdf),pdf_size_bytes:pdf.length});
    const bytes=canonical(manifest);
    return Object.freeze({manifest,manifest_canonical:bytes,manifest_digest:sha(bytes),html,pdf_bytes:Buffer.from(pdf)});
  }});
}
// Integrity ONLY; self-rehashed data is not an authenticated issued document.
// Never use this helper to accept browser bundles or authorize signing/sending.
function verifyReviewBundleIntegrity(bundle){try{
  check(bundle && typeof bundle.html==='string' && Buffer.byteLength(bundle.html,'utf8')<=MAX_HTML);
  const m=bundle.manifest,pdf=pdfCopy(bundle.pdf_bytes);
  check(m?.protocol==='retail_agreement_review_bundle_v1' && m.schema_version===1 && UUID.test(m.document_id)
    && m.publication==='draft_only' && m.refund_policy_reference===null && m.acceptance_state==='unsigned'
    && m.signing_enabled===false && m.send_enabled===false && m.checkout_enabled===false
    && m.html_sha256===sha(bundle.html) && m.pdf_sha256===sha(pdf) && m.pdf_size_bytes===pdf.length
    && bundle.manifest_canonical===canonical(m) && bundle.manifest_digest===sha(bundle.manifest_canonical));return true;
  }catch(_){return false;}}
module.exports={TEMPLATE_VERSION,createRetailMembershipReviewService,verifyReviewBundleIntegrity};
