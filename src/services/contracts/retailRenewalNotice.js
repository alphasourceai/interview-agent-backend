'use strict';

// Reminder rendering/policy only. No configured mail client, provider, DB,
// source/clock authority or access change. Existing processor owns dispatch.
const {readRetailPackageOffer}=require('../membershipPackageCompatibility');
const {STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION}=require('../membershipOffers');
const {validMembershipBuyerEmail}=require('../membershipCapabilityPredicates');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {snapshotStripeSdkData:snapshot}=require('../enterprisePoolPaymentProof');
function held(){throw Object.assign(new Error('retail_renewal_notice_held'),{code:'retail_renewal_notice_held',status:503});}
function noticeEmail(value){
 if(typeof value!=='string'||/[\r\n]/.test(value))held();
 const email=value.trim().toLowerCase();if(!validMembershipBuyerEmail(email))held();return email;
}
function noticeRecipientHash(value){return createHash('sha256').update(noticeEmail(value),'utf8').digest('hex');}
function configuredNoticeRecipients(env=process.env){
 try{
  const raw=env.RETAIL_RENEWAL_NOTICE_ALLOW_RECIPIENTS;
  if(typeof raw!=='string'||raw.length>32768)return[];
  const values=JSON.parse(raw);
  if(!Array.isArray(values)||!values.length||values.length>100)return[];
  return [...new Set(values.map(noticeEmail))];
 }catch(_){return[];}
}
function noticeProviderAck(result){
 const status=result?.skipped===true?undefined:result?.statusCode;
 const outcome=status===202?'accepted':Number.isInteger(status)&&status>=400&&status<500?'rejected':'unknown';
 const reference=typeof result?.providerReference==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(result.providerReference)
  ?result.providerReference:null;
 return{outcome,provider_reference:reference};
}
function checkedNoticeFacts(facts){
 const offer=readRetailPackageOffer(facts?.package_snapshot),b=facts?.billing_cutoff_at;
 if(![STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION].includes(offer?.offer_version)||offer.renewal.reminder_days!==30
  ||typeof b!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(b)
  ||!Number.isFinite(Date.parse(b))||new Date(b).toISOString()!==b)held();
 return{offer,b};
}
function renderRetailRenewalNotice(facts,{buildBrandedEmailShell,escapeHtml}={}){
 const {offer,b}=checkedNoticeFacts(facts);
 if(typeof buildBrandedEmailShell!=='function'||typeof escapeHtml!=='function')held();
 const plan=offer.display_name,months=offer.commitment_months;
 const price=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(offer.platform_payment_cents/100);
 const date=new Date(b).toUTCString();
 const priceLine=offer.payment_option==='prepaid'?`${price} prepaid per ${months}-month term`
  :`${price} per month during each ${months}-month commitment`;
 const paymentLine=offer.payment_option==='prepaid'
  ?'Turning renewal off does not shorten your already-paid membership term.'
  :'Turning renewal off does not cancel the installments still owed for your current commitment.';
 const lines=[`Your ${plan} membership is scheduled to renew for another ${months}-month term.`,
  `Next Stripe renewal: ${date}.`,`Platform price in your agreement: ${priceLine}.`,
  'Applicable tax, agreed discounts, role charges and additional-interview charges remain governed by your agreement.',
  'To stop the next renewal, turn off auto-renew in your alphaScreen Billing page before that renewal instant.',
  'This reminder is not an earlier cancellation deadline.',paymentLine,
  'Your accepted agreement, current payment obligations and refund policy continue to apply.'];
 const escaped=lines.map(line=>escapeHtml(line));
 return{subject:`Your alphaScreen renewal: ${plan} — ${months} months`,text:lines.join('\n\n'),
  html:buildBrandedEmailShell({title:'Your alphaScreen membership renewal',preheader:`Your next renewal is ${date}.`,
   contentHtml:escaped.map(line=>`<p>${line}</p>`).join('')})};
}
async function processRetailRenewalNotice({db,agreementId,clientId,enabled=false,allowRecipients=[],send=null}={}){
 if(enabled!==true)return{status:'disabled'};
 if(!Array.isArray(allowRecipients)||!allowRecipients.length||allowRecipients.length>100)return{status:'held',code:'notice_allowlist_unavailable'};
 let allowed;try{allowed=new Set(allowRecipients.map(noticeEmail));}catch(_){return{status:'held',code:'notice_allowlist_unavailable'};}
 if(send!==null&&typeof send!=='function')return{status:'held',code:'notice_sender_unavailable'};
 if(!send&&!String(process.env.SENDGRID_API_KEY||'').trim())return{status:'held',code:'notice_sender_unavailable'};
 try{
  const source=await require('../existingRetailRecurringSource').readExistingRetailRecurringSource({db,agreementId,clientId});
  const a=await db.from('membership_agreements').select('id,client_id,admin_email').eq('id',agreementId).eq('client_id',clientId).maybeSingle();
  const profiles=await db.from('billing_customers').select('id,client_id,primary_contact_email',{count:'exact'})
   .eq('stripe_customer_id',source.original_period.customer_id);
  if(a.error||!a.data||profiles.error||profiles.count!==1||!Array.isArray(profiles.data)||profiles.data.length!==1
   ||profiles.data[0].client_id!==clientId)held();
  const recipient=noticeEmail(a.data.admin_email);
  if(recipient!==noticeEmail(profiles.data[0].primary_contact_email)||!allowed.has(recipient))return{status:'held',code:'notice_recipient_unapproved'};
  const hash=noticeRecipientHash(recipient);
  const args={p_agreement:agreementId,p_client:clientId,p_action:'claim',p_ack:null,p_expected_recipient_sha256:hash,p_attempt_identity:null};
  const response=snapshot(await db.rpc('retail_existing_renewal_notice',args));
  if(response.error||!response.data)held();
  const claim=response.data;
  if(['held','not_due','already_attempted'].includes(claim.status))return{status:claim.status,code:claim.code};
  const facts=claim.facts;
  if(claim.status!=='claimed'||facts?.version!=='retail_existing_renewal_notice_v1'||facts.template_version!==facts.version
   ||facts.agreement_id!==agreementId||facts.client_id!==clientId||facts.recipient_sha256!==hash
   ||facts.recipient_email!==recipient||!isDeepStrictEqual(snapshot(source.package_snapshot),snapshot(facts.package_snapshot)))held();
  checkedNoticeFacts(facts);
  if(claim.attempt_identity!==`retail-renewal-notice:${agreementId}:${facts.billing_cutoff_at}:attempted`)held();
  // RPC returned after its attempt transaction committed. This is the only
  // provider call; a missing response/unknown is never automatically resent.
  let ack={outcome:'unknown',provider_reference:null};
  try{
   const deliver=send||((to,f)=>require('../../clients/sendgrid').sendRetailRenewalNoticeEmail(to,f));
   ack=noticeProviderAck(await deliver(recipient,facts));
  }catch(_){/* No provider acceptance or delivery inferred from an exception. */}
  try{
   const recorded=snapshot(await db.rpc('retail_existing_renewal_notice',{...args,p_action:'record',p_ack:ack,p_attempt_identity:claim.attempt_identity}));
   if(recorded.error||recorded.data?.status!=='recorded')return{status:'unknown',code:'notice_ack_unconfirmed'};
  }catch(_){return{status:'unknown',code:'notice_ack_unconfirmed'};}
  return{status:ack.outcome}; // accepted means API acceptance, NOT recipient delivery.
 }catch(_){return{status:'held',code:'retail_renewal_notice_held'};}
}
module.exports={noticeEmail,noticeRecipientHash,configuredNoticeRecipients,noticeProviderAck,renderRetailRenewalNotice,processRetailRenewalNotice};
