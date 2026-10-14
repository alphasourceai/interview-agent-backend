'use strict';
// Exact owner-only recipient fence on the existing SendGrid transport, not a
// new sender, invitation, queue or notification workflow.
const {validMembershipBuyerEmail}=require('../services/membershipCapabilityPredicates');
function denied(){throw new Error('dev_pricing_test_mail_denied');}
function address(value){
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  if(!Object.keys(value).every(k=>['email','name'].includes(k))||typeof value.email!=='string'
   ||value.name!=null&&(typeof value.name!=='string'||/[\r\n]/.test(value.name)))denied();
  value=value.email;
 }
 if(typeof value!=='string'||/[\r\n]/.test(value))denied();
 const email=value.trim().toLowerCase();if(!validMembershipBuyerEmail(email))denied();return email;
}
function ownerMailRecipients(raw){
 if(raw==null||raw==='')return[];
 if(typeof raw!=='string'||raw.length>8000)denied();
 const parts=raw.split(',').map(s=>s.trim());
 const result=parts.map(address);
 if(parts.some((s,i)=>s!==result[i]))denied();
 if(!result.length||result.length>30||new Set(result).size!==result.length
  ||result.some(e=>!/^jason\+pricingdev-[a-z0-9-]+@alphasourceai\.com$/.test(e)))denied();
 return result;
}
function assertOwnerOnlyMail(messages,allowed){
 if(!Array.isArray(allowed)||!allowed.length)denied();
 const set=new Set(allowed),list=Array.isArray(messages)?messages:[messages];
 if(!list.length||list.length>30)denied();
 function recipients(value,required=false){
  if(value==null){if(required)denied();return;}
  const items=Array.isArray(value)?value:[value];if(!items.length||items.length>30)denied();
  for(const item of items)if(!set.has(address(item)))denied();
 }
 for(const raw of list){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))denied();
  if(raw.from!=null&&address(raw.from)!=='info@alphasourceai.com')denied();
  // Plain source shapes are checked as well as the real SDK wire shape. Do not
  // let display-name strings or a hidden second raw recipient through.
  for(const source of [raw,...(Array.isArray(raw.personalizations)?raw.personalizations:[])]){
   if(!source||typeof source!=='object')denied();
   for(const key of ['to','cc','bcc'])if(source[key]!=null)recipients(source[key]);
  }
  // Reuse the installed SDK's own canonicalization, including camel/snake
  // aliases and personalizations. Inspect the recipients it would really send.
  let msg;try{msg=require('@sendgrid/helpers').classes.Mail.create(raw).toJSON();}catch(_){denied();}
  if(!msg||typeof msg!=='object'||Array.isArray(msg)||address(msg.from)!=='info@alphasourceai.com')denied();
  // These SendGrid settings can add an otherwise hidden recipient.
  if(msg.mail_settings?.bcc!=null||msg.mailSettings?.bcc!=null)denied();
  if(Object.keys(msg.headers||{}).length)denied();
  if(msg.reply_to!=null&&address(msg.reply_to)!=='info@alphasourceai.com')denied();
  if(msg.reply_to_list!=null)denied();
  const personal=msg.personalizations;
  if(personal!=null&&(!Array.isArray(personal)||!personal.length||personal.length>30))denied();
  recipients(msg.to,personal==null);recipients(msg.cc);recipients(msg.bcc);
  for(const p of personal||[]){
   if(!p||typeof p!=='object'||Array.isArray(p))denied();
   if(p.from!=null&&address(p.from)!=='info@alphasourceai.com')denied();
   if(Object.keys(p.headers||{}).length)denied();
   recipients(p.to,true);recipients(p.cc);recipients(p.bcc);
  }
 }
}
module.exports={ownerMailRecipients,assertOwnerOnlyMail};
