'use strict';
// Prospective server-owned pool terms. No provider/client/Auth/default SDK.
const crypto=require('node:crypto'),{isProxy}=require('node:util').types;
const {quoteEnterprisePoolOffer,POOL_OFFER_VERSION}=require('./enterprisePoolOffers');
const {defaultBillingModelForPlanTier}=require('./billingModel');
const FIELDS=['offer_version','currency','quantity','unit_price_cents','gross_cents','automatic_discount_percent','automatic_discount_cents','coupon_cents','net_cents'];
const MAX=2147483647;
// Fixed nine-field order, decimal integers, no whitespace, UTF8. Never hash
// jsonb::text or caller property order.
const canonical=v=>JSON.stringify(Object.fromEntries(FIELDS.map(k=>[k,v[k]])));
const digest=s=>crypto.createHash('sha256').update(canonical(s)).digest('hex');
function fail(){const e=new Error('invalid_enterprise_pool_snapshot');e.code='invalid_enterprise_pool_snapshot';e.status=409;throw e;}
function check(v){if(!v)fail();}
function validateEnterprisePoolSnapshot(input,expectedDigest){
  check(input && typeof input==='object' && !Array.isArray(input) && !isProxy(input)
    && [Object.prototype,null].includes(Object.getPrototypeOf(input)));
  const d=Object.getOwnPropertyDescriptors(input);check(Reflect.ownKeys(d).length===FIELDS.length
    && Reflect.ownKeys(d).every(k=>typeof k==='string' && FIELDS.includes(k) && d[k].enumerable && Object.hasOwn(d[k],'value')));
  const s=Object.fromEntries(FIELDS.map(k=>[k,d[k].value]));
  check(s.offer_version===POOL_OFFER_VERSION && s.currency==='usd'
    && FIELDS.slice(2).every(k=>Number.isSafeInteger(s[k]) && s[k]>=0 && s[k]<=MAX)
    && s.quantity>=1 && s.unit_price_cents>=1 && s.automatic_discount_percent<=10);
  let recomputed;try{recomputed=quoteEnterprisePoolOffer({quantity:s.quantity,acceptedUnitPriceCents:s.unit_price_cents,
    authorizedAutomaticPercent:s.automatic_discount_percent,authorizedCouponCents:s.coupon_cents});}catch(_){fail();}
  check(canonical(recomputed)===canonical(s) && typeof expectedDigest==='string'
    && /^[0-9a-f]{64}$/.test(expectedDigest) && digest(s)===expectedDigest);return Object.freeze(s);
}
function readEnterprisePoolSnapshot(input={}){
  if(input.pool_offer_snapshot==null && input.pool_offer_digest==null)return null;
  return validateEnterprisePoolSnapshot(input.pool_offer_snapshot,input.pool_offer_digest);
}
function prepareEnterprisePoolTerms(payload={}){
  if(String(payload.membership_tier||'').toLowerCase()!=='enterprise')return payload;
  const model=String(payload.billing_model||defaultBillingModelForPlanTier('enterprise')).toLowerCase(),quantity=Number(payload.pool_quantity);
  if(model!=='usage' || !Number.isInteger(quantity) || quantity<=0)return {...payload,pool_quantity:'',pool_discount_pct:'',pool_total_cents:null,pool_discount_priced:false,pool_offer_snapshot:null,pool_offer_digest:null};
  let offer;try{offer=quoteEnterprisePoolOffer({quantity,acceptedUnitPriceCents:Number(payload.usage_interview_fee_cents)});}catch(_){fail();}
  const hash=digest(offer),snapshot=validateEnterprisePoolSnapshot(offer,hash);
  // All discount/coupon/version/snapshot claims in payload are overwritten.
  return {...payload,billing_model:'usage',pool_discount_pct:String(snapshot.automatic_discount_percent),pool_total_cents:snapshot.net_cents,
    pool_discount_priced:true,pool_offer_snapshot:snapshot,pool_offer_digest:hash};
}
function enterprisePoolCheckoutQuote(input={}){
  const s=readEnterprisePoolSnapshot(input);if(!s)return null;
  check(input.billing_model==='usage' && ['pool_quantity','usage_interview_fee_cents','pool_discount_pct','pool_total_cents'].every(k=>input[k]!=null && String(input[k]).trim()!=='')
    && Number(input.pool_quantity)===s.quantity && Number(input.usage_interview_fee_cents)===s.unit_price_cents
    && Number(input.pool_discount_pct)===s.automatic_discount_percent && Number(input.pool_total_cents)===s.net_cents);
  return Object.freeze({quantity:s.quantity,unit_price_cents:s.unit_price_cents,discount_pct:s.automatic_discount_percent,
    discounted_unit_price_cents:Math.round(s.net_cents/s.quantity),total_cents:s.net_cents,offer_snapshot:s,offer_digest:digest(s)});
}
module.exports={prepareEnterprisePoolTerms,readEnterprisePoolSnapshot,validateEnterprisePoolSnapshot,enterprisePoolCheckoutQuote};
