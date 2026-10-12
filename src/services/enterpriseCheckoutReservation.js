'use strict';

// UNMOUNTED passive intent. No Stripe SDK, artifact verification, account/member
// creation, payment/credit/access writer or existing-checkout fallback imported.
const crypto=require('node:crypto'),{isProxy}=require('node:util').types;
const {validateEnterprisePoolSnapshot}=require('./enterprisePoolSnapshot');
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const FALSE_FLAGS=['checkout_creation_authorized','provider_binding_verified','source_artifacts_verified','credits_spendable'];
const nativeId=(v,p)=>typeof v==='string' && new RegExp(`^${p}_[A-Za-z0-9_]+$`).test(v);
const instant=v=>typeof v==='string' && Number.isFinite(Date.parse(v));
const email=v=>typeof v==='string'?v.trim().toLowerCase():'';
function sourceCents(value){
 if(!['number','string'].includes(typeof value) || !/^[0-9]+(\.[0-9]{1,2})?$/.test(String(value)))return null;
 const [whole,fraction='']=String(value).split('.');
 const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 return n>0n && n<=2147483647n?Number(n):null;
}
function fail(code,status=409){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function dataObject(value,keys){
 check(value && typeof value==='object' && !Array.isArray(value) && !isProxy(value)
  && [Object.prototype,null].includes(Object.getPrototypeOf(value)),'enterprise_reservation_invalid_request',400);
 const d=Object.getOwnPropertyDescriptors(value);
 check(Reflect.ownKeys(d).length===keys.length && Reflect.ownKeys(d).every(k=>typeof k==='string' && keys.includes(k)
  && d[k].enumerable && Object.hasOwn(d[k],'value')),'enterprise_reservation_invalid_request',400);
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
const keyHash=(owner,key)=>crypto.createHash('sha256').update(`enterprise-reservation-v2\n${owner}\n${key}`,'utf8').digest('hex');
const same=(a,b)=>a.id===b.id && a.email===b.email;

function createEnterpriseCheckoutReservationService({db,configuration}={}){
 const config=dataObject(configuration,['projectRef','environment','providerAccountId','livemode']);
 check(/^[a-z0-9]{20}$/.test(config.projectRef) && ['dev','staging','production'].includes(config.environment)
  && nativeId(config.providerAccountId,'acct') && typeof config.livemode==='boolean'
  && (config.environment==='production')===config.livemode,'enterprise_reservation_configuration_invalid',503);
 Object.freeze(config);
 const origin=`https://${config.projectRef}.supabase.co`;
 check(db && typeof db.from==='function' && typeof db.rpc==='function' && typeof db.auth?.getUser==='function'
  && [origin,`${origin}/`].includes(db.supabaseUrl),'enterprise_reservation_project_mismatch',503);
 const getUser=db.auth.getUser.bind(db.auth);
 async function authenticate(token){
  check([origin,`${origin}/`].includes(db.supabaseUrl),'enterprise_reservation_project_mismatch',503);
  let result;try{result=await getUser(token);}catch(_){fail('enterprise_reservation_auth_unavailable',503);}
  const user=result?.data?.user;
  check(!result?.error && user && UUID.test(user.id) && user.is_anonymous===false && user.deleted_at==null
   && instant(user.email_confirmed_at) && Date.parse(user.email_confirmed_at)<=Date.now()
   && (user.banned_until==null || (instant(user.banned_until) && Date.parse(user.banned_until)<=Date.now()))
   && email(user.email).length>0,'enterprise_reservation_scope_denied',403);
  return Object.freeze({id:user.id,email:email(user.email)});
 }
 async function one(query){let r;try{r=await query.maybeSingle();}catch(_){fail('enterprise_reservation_store_unavailable',503);}
  check(!r?.error,'enterprise_reservation_store_unavailable',503);return r?.data||null;}
 return Object.freeze({async reserve(subject,input){
  const request=dataObject(input,['agreementId','idempotencyKey']),identity=dataObject(subject,['accessToken']);
  check(UUID.test(request.agreementId) && typeof request.idempotencyKey==='string'
   && /^[A-Za-z0-9_.:-]{16,128}$/.test(request.idempotencyKey)
   && typeof identity.accessToken==='string' && identity.accessToken.length>=20 && identity.accessToken.length<=8192
   && !/\s/.test(identity.accessToken),'enterprise_reservation_invalid_request',400);
  const principal=await authenticate(identity.accessToken);
  const agreement=await one(db.from('membership_agreements').select('id,client_id,admin_email').eq('id',request.agreementId));
  check(agreement?.id===request.agreementId && UUID.test(agreement.client_id)
   && email(agreement.admin_email)===principal.email,'enterprise_reservation_scope_denied',403);
  const client=await one(db.from('clients').select('id,parent_client_id,archived_at,stripe_customer_id').eq('id',agreement.client_id));
  check(client?.id===agreement.client_id && client.parent_client_id===null && client.archived_at===null
   && nativeId(client.stripe_customer_id,'cus'),'enterprise_reservation_scope_denied',403);
  check(same(principal,await authenticate(identity.accessToken)),'enterprise_reservation_scope_changed',403);
  const args={p_id:crypto.randomUUID(),p_pool:crypto.randomUUID(),p_agreement:request.agreementId,p_owner:principal.id,
   p_environment:config.environment,p_account:config.providerAccountId,p_mode:config.livemode,
   p_customer:client.stripe_customer_id,p_key_hash:keyHash(principal.id,request.idempotencyKey)};
  let ack,unknown=false;
  try{ack=await db.rpc('enterprise_v2_reserve_checkout',args);}catch(e){
   if(/^[0-9A-Z]{5}$/.test(e?.code||''))fail('enterprise_reservation_denied',e.code==='42501'?503:409);unknown=true;
  }
  if(ack?.error){
   if(/^[0-9A-Z]{5}$/.test(ack.error.code||''))fail('enterprise_reservation_denied',ack.error.code==='42501'?503:409);unknown=true;
  }
  if(!unknown)check(ack?.data && ['reserved','already_reserved'].includes(ack.data.action)
   && UUID.test(ack.data.operation_id) && UUID.test(ack.data.pool_id)
   && (ack.data.action!=='reserved' || (ack.data.operation_id===args.p_id && ack.data.pool_id===args.p_pool)),
   'enterprise_reservation_ack_unverified',503);
  check(same(principal,await authenticate(identity.accessToken)),'enterprise_reservation_scope_changed',403);
  // A second READ-only native check, never a second reservation or provider call.
  const {p_id,p_pool,...readArgs}=args;let result;
  try{result=await db.rpc('enterprise_v2_read_checkout',readArgs);}catch(_){fail('enterprise_reservation_readback_unavailable',503);}
  check(!result?.error,'enterprise_reservation_readback_unavailable',503);
  const o=result?.data?.operation,p=result?.data?.pool;
  check(o && UUID.test(o.id) && UUID.test(o.pool_id) && o.id!==o.pool_id
   && o.agreement_id===request.agreementId && o.billing_owner_user_id===principal.id && o.client_id===client.id
   && o.environment===config.environment && o.expected_provider_account_id===config.providerAccountId
   && o.expected_livemode===config.livemode && o.expected_customer_id===client.stripe_customer_id
   && o.request_key_hash===args.p_key_hash && FALSE_FLAGS.every(k=>o[k]===false)
   && HASH.test(o.source_digest||'') && o.source_snapshot?.protocol==='enterprise_signed_source_v2'
   && o.source_snapshot.document_fields?.id===request.agreementId
   && o.source_snapshot.document_fields?.client_id===client.id
   && o.source_snapshot.document_fields?.membership_tier==='enterprise'
   && email(o.source_snapshot.document_fields?.admin_email)===principal.email
   && o.source_snapshot.signature_fields?.signer_accepted===true
   && HASH.test(o.source_snapshot.signature_fields?.signature_sha256||'')
   && Number.isSafeInteger(o.platform_cents) && o.platform_cents>0 && o.platform_cents<=2147483647
   && ['month','year'].includes(o.platform_interval) && instant(o.created_at) && instant(o.expires_at)
   && instant(o.calendar_anchor_at) && Date.parse(o.expires_at)-Date.parse(o.created_at)===3600000
   && Date.parse(o.expires_at)<Date.parse(o.calendar_anchor_at) && Date.parse(o.expires_at)>Date.now()
   && Date.parse(o.created_at)<=Date.now() && Date.parse(o.created_at)%1000===0
   && instant(o.source_snapshot.document_fields.agreement_expires_at)
   && Date.parse(o.expires_at)<=Date.parse(o.source_snapshot.document_fields.agreement_expires_at),
   'enterprise_reservation_readback_unverified',503);
  if(!unknown)check(o.id===ack.data.operation_id && o.pool_id===ack.data.pool_id,'enterprise_reservation_readback_unverified',503);
  const offer=validateEnterprisePoolSnapshot(o.pool_offer_snapshot,o.pool_offer_digest);
  const sourceValues=o.source_snapshot.template_snapshot?.values,sourceDoc=o.source_snapshot.document_fields;
  const start=new Date(o.created_at),expectedAnchor=Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1);
  check(sourceValues && sourceValues.billing_model==='usage' && sourceValues.membership_tier==='enterprise'
   && sourceCents(sourceValues.platform_fee)===o.platform_cents
   && ['monthly','annual'].includes(sourceDoc.billing_option)
   && o.platform_interval===(sourceDoc.billing_option==='annual'?'year':'month')
   && Date.parse(o.calendar_anchor_at)===expectedAnchor
   && JSON.stringify(validateEnterprisePoolSnapshot(sourceValues.pool_offer_snapshot,sourceValues.pool_offer_digest))===JSON.stringify(offer),
   'enterprise_reservation_readback_unverified',503);
  check(offer.net_cents>0 && p && p.id===o.pool_id && p.checkout_operation_id===o.id && p.client_id===o.client_id
   && p.status==='pending' && p.stripe_checkout_session_id===null && p.stripe_payment_intent_id===null && p.paid_at===null
   && p.created_at===o.created_at && p.offer_digest===o.pool_offer_digest
   && p.quantity_purchased===offer.quantity && p.unit_price_cents===offer.unit_price_cents
   && Number(p.discount_pct)===offer.automatic_discount_percent && p.total_cents===offer.net_cents,
   'enterprise_reservation_readback_unverified',503);
  const poolOffer=validateEnterprisePoolSnapshot(p.offer_snapshot,p.offer_digest);
  check(JSON.stringify(poolOffer)===JSON.stringify(offer),'enterprise_reservation_readback_unverified',503);
  check(same(principal,await authenticate(identity.accessToken)),'enterprise_reservation_scope_changed',403);
  return Object.freeze({operation_id:o.id,pool_id:o.pool_id,platform_cents:o.platform_cents,platform_interval:o.platform_interval,
   pool_quantity:offer.quantity,pool_net_cents:offer.net_cents,created_at:o.created_at,expires_at:o.expires_at,
   calendar_anchor_at:o.calendar_anchor_at,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false])),
   persistence:unknown?'recovered_unknown_commit':'verified'});
 }});
}
module.exports={createEnterpriseCheckoutReservationService};
