'use strict';
// Existing Enterprise Checkout orchestration, no cash/Auth/credit settlement.
const {isDeepStrictEqual}=require('node:util');
const {collect}=require('./existingRetailCheckoutFunding');
const {ensureRetailBillingProfile,frozenRetailCancelUrl}=require('./existingRetailCheckoutAttempt');
const {enterprisePoolCheckoutQuote}=require('./enterprisePoolSnapshot');
const {validateEnterpriseSettings,enterpriseSettingsMetadata}=require('./enterpriseSettings');
const id=v=>typeof v==='string'?v:v?.id;
const whole=v=>Number.isSafeInteger(v)&&v>=0;
function fail(code,status=409){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(v,code='enterprise_checkout_mismatch',status=409){if(!v)fail(code,status);}
const sameKeys=(a,b)=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).sort().join(',')===Object.keys(b).sort().join(',');
function dollarsToCents(value){
 const s=String(value??'');check(/^[0-9]+(\.[0-9]{1,2})?$/.test(s),'enterprise_checkout_money_invalid');
 const [w,f='']=s.split('.'),n=BigInt(w)*100n+BigInt(f.padEnd(2,'0'));
 check(n>0n&&n<=2147483647n,'enterprise_checkout_money_invalid');return Number(n);
}
const moneyString=n=>`${Math.floor(n/100)}${n%100?'.'+String(n%100).padStart(2,'0').replace(/0$/,''):''}`;
function terms(a){
 const v=a.template_snapshot?.values,o=enterprisePoolCheckoutQuote(v),settings=validateEnterpriseSettings(v,{planTier:'enterprise'});
 check(o?.total_cents>0&&v.membership_tier==='enterprise'&&v.billing_model==='usage'&&v.billing_option===a.billing_option
  &&['monthly','annual'].includes(a.billing_option)&&settings.ok,'enterprise_checkout_source_mismatch');
 for(const k of ['per_role_fee','included_interviews_per_role','additional_interview_fee'])check(/^(0+)(\.0{1,2})?$/.test(String(v[k])), 'enterprise_checkout_source_mismatch');
 return {pool:o,platform:dollarsToCents(v.platform_fee),settings:settings.settings};
}
async function readOne(db,table,key,value){
 let r;try{r=await db.from(table).select('*').eq(key,value).maybeSingle();}catch(_){fail('enterprise_checkout_source_unavailable',503);}
 check(r&&!r.error&&r.data&&!Array.isArray(r.data),'enterprise_checkout_source_unavailable',503);return r.data;
}
async function nativeSource(db,expected,fees){
 check(expected?.id&&expected.client_id&&expected.template_snapshot,'enterprise_checkout_source_required');
 const a=await readOne(db,'membership_agreements','id',expected.id),s=await readOne(db,'enterprise_v2_execution_seals','agreement_id',expected.id);
 const e=a.template_snapshot?.execution,{execution,...unsigned}=a.template_snapshot||{};
 check(a.client_id===expected.client_id&&isDeepStrictEqual(a.template_snapshot,expected.template_snapshot)
  &&a.status==='signed'&&a.is_current===true&&!a.superseded_at&&!a.superseded_by_agreement_id&&!a.checkout_paid_at
  &&a.membership_tier==='enterprise'&&a.signer_accepted===true&&s.agreement_id===a.id&&s.token_hash===a.signer_token_hash
  &&isDeepStrictEqual(s.source_snapshot,unsigned)&&isDeepStrictEqual(s.execution,e)&&e?.version==='enterprise_execution_v2'
  &&s.attempt_id===e.attempt_id&&Date.parse(s.signed_at)===Date.parse(a.signed_at)&&Date.parse(e.signed_at)===Date.parse(a.signed_at),
 'enterprise_checkout_source_mismatch');
 for(const k of ['signer_typed_name','signature_image_path','signature_sha256','executed_pdf_path','signer_ip','signer_user_agent'])
  check(a[k]===e[k],'enterprise_checkout_seal_mismatch');
 const t=terms(a),v=a.template_snapshot.values;
 for(const k of ['platform_fee','per_role_fee','included_interviews_per_role','additional_interview_fee','usage_interview_fee_cents','pool_quantity',
  'pool_discount_pct','pool_total_cents','pool_offer_snapshot','pool_offer_digest','billing_model','rollover_days','max_interview_minutes','scored_question_count'])
  check(isDeepStrictEqual(fees?.[k]??'',v[k]??''),'enterprise_checkout_source_mismatch');
 const intents=await db.from('public_purchase_intents').select('id',{count:'exact'}).eq('agreement_id',a.id);
 check(intents&&!intents.error&&intents.count===0&&Array.isArray(intents.data)&&intents.data.length===0,'enterprise_checkout_source_mismatch');
 if(a.enterprise_checkout_source==null){
  for(const k of ['enterprise_checkout_pool_id','enterprise_checkout_prices','checkout_created_at','checkout_session_id','checkout_paid_at','checkout_status',
   'checkout_attempt_source','checkout_embedded','replaces_stripe_subscription_id','replacement_policy'])check(a[k]==null,'enterprise_checkout_untracked_attempt');
 }else {
  const src=a.enterprise_checkout_source;
  check(sameKeys(src,{version:0,material:0,pool_id:0,created_at:0,expires_at:0,embedded:0,replacement_id:0,config:0})
   &&src.version==='enterprise_existing_pending_v1'&&a.enterprise_checkout_pool_id===src.pool_id
   &&src.material?.agreement_id===a.id&&src.material.client_id===a.client_id&&isDeepStrictEqual(src.material.template_snapshot,a.template_snapshot),
  'enterprise_checkout_untracked_attempt');
  if(a.enterprise_checkout_prices!=null)check(sameKeys(a.enterprise_checkout_prices,{platform_price_id:0,pool_price_id:0})
   &&Object.values(a.enterprise_checkout_prices).every(v=>/^price_[A-Za-z0-9_]+$/.test(v))
   &&a.enterprise_checkout_prices.platform_price_id!==a.enterprise_checkout_prices.pool_price_id,'enterprise_checkout_untracked_attempt');
  check(a.checkout_attempt_source==null&&a.checkout_embedded==null,'enterprise_checkout_untracked_attempt');
  if(a.checkout_session_id==null){for(const k of ['checkout_created_at','checkout_status','replaces_stripe_subscription_id','replacement_policy'])check(a[k]==null,'enterprise_checkout_untracked_attempt');}
  else check(a.enterprise_checkout_prices!=null&&/^cs_[A-Za-z0-9_]+$/.test(a.checkout_session_id)&&a.checkout_status==='pending_payment'
   &&Date.parse(a.checkout_created_at)===Date.parse(src.created_at)&&a.replaces_stripe_subscription_id===src.replacement_id
   &&(a.replacement_policy??null)===(src.replacement_id?'immediate_cancel':null),'enterprise_checkout_untracked_attempt');
 }
 return {a,t};
}
function windowOf(source){
 const b=Date.parse(source?.created_at),legal=Date.parse(source?.material?.agreement_expires_at),expiry=Date.parse(source?.expires_at),now=Date.now();
 check(Number.isFinite(b)&&Number.isFinite(legal)&&Number.isFinite(expiry)&&b<=now,'enterprise_checkout_clock_mismatch',503);
 const d=new Date(b),first=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
 // V8 truncates native microseconds; SDK expires_at is the conservative floor.
 check(Math.floor(expiry/1000)===Math.floor(Math.min(legal,first-1000,b+86400000-1000)/1000),'enterprise_checkout_clock_mismatch',503);
 const expires=Math.floor(expiry/1000);check(now<b+86400000&&expires*1000-now>=1800000,'enterprise_checkout_window_closed',410);
 return {b,expires,anchor:Math.floor(first/1000)};
}
function assertAttempt(attempt,a,customer,config,embedded){
 const s=attempt?.source;
 check(sameKeys(attempt,{source:0,prices:0,checkout_session_id:0})&&sameKeys(s,{version:0,material:0,pool_id:0,created_at:0,expires_at:0,embedded:0,replacement_id:0,config:0})
  &&s.version==='enterprise_existing_pending_v1'&&s.material?.agreement_id===a.id&&s.material.client_id===a.client_id
  &&s.material.customer_id===customer&&isDeepStrictEqual(s.material.template_snapshot,a.template_snapshot)
  &&s.material.signer_token_hash===a.signer_token_hash&&s.material.template_version===a.template_version
  &&isDeepStrictEqual(s.config,config)&&s.embedded===embedded&&/^[0-9a-f-]{36}$/.test(s.pool_id)
  &&(s.replacement_id===null||/^sub_[A-Za-z0-9_]+$/.test(s.replacement_id))
  &&(attempt.checkout_session_id===null||/^cs_[A-Za-z0-9_]+$/.test(attempt.checkout_session_id)), 'enterprise_checkout_attempt_mismatch',503);
 if(attempt.prices!==null)check(sameKeys(attempt.prices,{platform_price_id:0,pool_price_id:0})
  &&Object.values(attempt.prices).every(p=>/^price_[A-Za-z0-9_]+$/.test(p))&&attempt.prices.platform_price_id!==attempt.prices.pool_price_id,'enterprise_checkout_attempt_mismatch',503);
 check(attempt.checkout_session_id===null||attempt.prices!==null,'enterprise_checkout_attempt_mismatch',503);windowOf(s);return attempt;
}
async function rpc(db,name,args){
 let r;try{r=await db.rpc(name,args);}catch(_){fail('enterprise_checkout_store_unavailable',503);}
 if(r?.error){if(/enterprise_.*window_(closed|denied)/.test(r.error.message||''))fail('enterprise_checkout_window_closed',410);fail('enterprise_checkout_store_hold',503);}
 check(r?.data&&!Array.isArray(r.data),'enterprise_checkout_store_unavailable',503);return r.data;
}
function metadataFor(a,t,source){
 const o=t.pool,v=a.template_snapshot.values;
 const pool={purchase_type:'interview_pool',client_interview_pool_id:source.pool_id,pool_quantity:String(o.quantity),pool_unit_price_cents:String(o.unit_price_cents),
  pool_discount_pct:String(o.discount_pct),pool_discounted_unit_price_cents:String((2n*BigInt(o.total_cents)+BigInt(o.quantity))/(2n*BigInt(o.quantity))),
  pool_total_cents:String(o.total_cents),pool_offer_version:o.offer_snapshot.offer_version,pool_offer_digest:o.offer_digest};
 const common={source:'agreement_checkout',client_id:a.client_id,agreement_id:a.id,plan_tier:'enterprise',billing_interval:a.billing_option,
  template_version:a.template_version,enterprise_checkout_version:'enterprise_existing_checkout_v1',
  ...(source.replacement_id?{replaces_stripe_subscription_id:source.replacement_id,replacement_policy:'immediate_cancel'}:{})};
 return {pool:{...common,purchase_type:'interview_pool',quantity:String(o.quantity),discount_pct:String(o.discount_pct),
  discounted_unit_price_cents:pool.pool_discounted_unit_price_cents,pool_offer_version:pool.pool_offer_version,pool_offer_digest:pool.pool_offer_digest,client_interview_pool_id:source.pool_id},
 platform:{...common,platform_fee:moneyString(t.platform),per_role_fee:'0',included_interviews_per_role:'0',additional_interview_fee:'0',
  usage_interview_fee_cents:String(v.usage_interview_fee_cents),...enterpriseSettingsMetadata(t.settings),client_interview_pool_id:source.pool_id},
 session:{...common,platform_fee:moneyString(t.platform),per_role_fee:'0',included_interviews_per_role:'0',additional_interview_fee:'0',
  usage_interview_fee_cents:String(v.usage_interview_fee_cents),...enterpriseSettingsMetadata(t.settings),...pool}};
}
async function effect(source,fn){windowOf(source);return fn();}
async function verifyPrice(stripe,source,p,amount,recurrence,metadata,name){
 check(p?.object==='price'&&/^price_[A-Za-z0-9_]+$/.test(p.id||'')&&p.active===true&&p.currency==='usd'&&p.unit_amount===amount
  &&typeof p.livemode==='boolean'&&p.unit_amount_decimal===String(amount)&&p.billing_scheme==='per_unit'
  &&p.type===(recurrence?'recurring':'one_time')&&sameKeys(p.metadata,metadata)&&isDeepStrictEqual(p.metadata,metadata)
  &&(recurrence?p.recurring?.interval===recurrence&&p.recurring.interval_count===1&&p.recurring.usage_type==='licensed':p.recurring===null),
 'enterprise_checkout_price_mismatch');
 const productId=id(p.product);check(/^prod_[A-Za-z0-9_]+$/.test(productId||''),'enterprise_checkout_product_mismatch');
 const product=await effect(source,()=>stripe.products.retrieve(productId));
 check(product?.object==='product'&&product.id===productId&&product.active===true&&product.name===name&&product.livemode===p.livemode,'enterprise_checkout_product_mismatch');return p;
}
async function readSession({stripe,attempt,t,metadata,success,cancel}){
 const source=attempt.source,w=windowOf(source),csid=attempt.checkout_session_id;
 const session=await effect(source,()=>stripe.checkout.sessions.retrieve(csid));
 check(session?.id===csid&&session.object==='checkout.session'&&session.mode==='subscription'&&id(session.customer)===source.material.customer_id
  &&session.currency==='usd'&&typeof session.livemode==='boolean'&&session.expires_at===w.expires,'enterprise_checkout_session_mismatch');
 check(session.status!=='complete'&&session.payment_status!=='paid','agreement_checkout_already_paid');
 check(session.status!=='expired','enterprise_checkout_window_closed',410);
 check(session.status==='open'&&session.payment_status==='unpaid'&&!id(session.subscription)&&session.ui_mode===(source.embedded?'embedded':'hosted')
  &&(source.embedded?session.return_url===success:session.success_url===success&&session.cancel_url===cancel)
  &&session.allow_promotion_codes===false&&sameKeys(session.metadata,metadata.session)&&isDeepStrictEqual(session.metadata,metadata.session),'enterprise_checkout_session_mismatch');
 const lines=await collect(after=>stripe.checkout.sessions.listLineItems(csid,{limit:100,...(after?{starting_after:after}:{})}),()=>windowOf(source));
 check(lines.data.length===2,'enterprise_checkout_lines_mismatch');let subtotal=0,tax=0;
 for(const line of lines.data){
  if(typeof line.price==='string')line.price=await effect(source,()=>stripe.prices.retrieve(line.price));
  const isPlatform=line.price?.id===attempt.prices.platform_price_id,isPool=line.price?.id===attempt.prices.pool_price_id;
  check(isPlatform!==isPool&&line.quantity===1&&line.currency==='usd'&&line.amount_discount===0&&whole(line.amount_subtotal)
   &&whole(line.amount_tax)&&line.amount_total===line.amount_subtotal+line.amount_tax,'enterprise_checkout_lines_mismatch');
  await verifyPrice(stripe,source,line.price,isPlatform?t.platform:t.pool.total_cents,isPlatform?(source.material.billing_option==='annual'?'year':'month'):null,
   isPlatform?metadata.platform:metadata.pool,isPlatform?'Enterprise membership':`Interview pool (${t.pool.quantity} interviews)`);
  check(line.price.livemode===session.livemode&&(isPool?line.amount_subtotal===t.pool.total_cents:line.amount_subtotal<=t.platform),'enterprise_checkout_lines_mismatch');
  subtotal+=line.amount_subtotal;tax+=line.amount_tax;
 }
 check(lines.data.filter(l=>l.price.id===attempt.prices.platform_price_id).length===1&&lines.data.filter(l=>l.price.id===attempt.prices.pool_price_id).length===1,
 'enterprise_checkout_lines_mismatch');
 const totalTax=session.total_details?.amount_tax;
 check(whole(subtotal)&&whole(tax)&&session.amount_subtotal===subtotal&&session.total_details?.amount_discount===0&&session.total_details?.amount_shipping===0
  &&(totalTax===tax||(totalTax==null&&tax===0))&&whole(session.amount_total)&&session.amount_total>0&&session.amount_total===subtotal+tax
  &&(session.automatic_tax!=null||tax===0),'enterprise_checkout_totals_mismatch');
 if(source.embedded)check(typeof session.client_secret==='string'&&session.client_secret.trim(),'enterprise_checkout_ack_unknown',503);
 else {let u;try{u=new URL(session.url);}catch(_){}check(u?.protocol==='https:'&&!u.username&&!u.password,'enterprise_checkout_ack_unknown',503);}
 return session;
}
async function createExistingEnterpriseCheckout({db,stripeFactory,resolveCustomer,client,agreement,fees,billingInterval,embedded,cancelUrl,key,config}){
 check(key===`agreement_checkout:${agreement?.id}:enterprise:${billingInterval}`&&typeof embedded==='boolean','enterprise_checkout_source_required');
 const {a,t}=await nativeSource(db,agreement,fees);
 check(a.client_id===client.id&&a.billing_option===billingInterval,'enterprise_checkout_source_mismatch');
 client=await readOne(db,'clients','id',a.client_id);check(!client.parent_client_id&&!client.archived_at&&client.email&&client.name,'enterprise_checkout_parent_denied');
 const source=a.enterprise_checkout_source,priorCustomer=client.stripe_customer_id??null;
 if(source)windowOf(source);
 const fence=()=>{if(source)windowOf(source);else {
  const now=Date.now(),d=new Date(now),first=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
  check(Math.min(Date.parse(a.agreement_expires_at),first-1000,now+86400000-1000)-now>=1800000,'enterprise_checkout_window_closed',410);
 }};
 if(source){
  check(source.material?.customer_id===client.stripe_customer_id,'enterprise_checkout_customer_changed');
  assertAttempt({source,prices:a.enterprise_checkout_prices??null,checkout_session_id:a.checkout_session_id??null},a,client.stripe_customer_id,config,embedded);
 }
 const stripe=stripeFactory();let customer,replacement=null;
 if(source){
  customer=source.material?.customer_id;check(customer===client.stripe_customer_id,'enterprise_checkout_customer_changed');
  await ensureRetailBillingProfile({db,client,customerId:customer,requireExisting:true});
 }else{
  fence();const r=await db.from('billing_customers').select('id,stripe_customer_id').eq('client_id',client.id).order('created_at',{ascending:false});
  check(r&&!r.error&&Array.isArray(r.data),'enterprise_checkout_source_unavailable',503);
  const guardedCustomerApi=Object.fromEntries(['retrieve','create','update'].map(method=>[method,(...args)=>{fence();return stripe.customers[method](...args);}]))
  customer=await resolveCustomer({stripe:{customers:guardedCustomerApi},client,billingCustomerList:r.data,exactPrepaid:true,skipCustomerUpdate:true,preferCurrentCustomer:true});
  check(/^cus_[A-Za-z0-9_]+$/.test(customer||''),'enterprise_checkout_customer_mismatch');
  await ensureRetailBillingProfile({db,client,customerId:customer});
  let q=db.from('clients').update({stripe_customer_id:customer}).eq('id',client.id);
  q=priorCustomer===null?q.is('stripe_customer_id',null):q.eq('stripe_customer_id',priorCustomer);
  const saved=await q.select('id,stripe_customer_id').maybeSingle();check(saved&&!saved.error&&saved.data?.stripe_customer_id===customer,'enterprise_checkout_customer_save_failed',503);
  const readback=await readOne(db,'clients','id',client.id);check(readback.stripe_customer_id===customer,'enterprise_checkout_customer_save_failed',503);
  const subs=await collect(after=>stripe.subscriptions.list({customer,status:'all',limit:100,...(after?{starting_after:after}:{})}),fence);
  check(subs.data.every(s=>s.object==='subscription'&&id(s.customer)===customer&&/^sub_[A-Za-z0-9_]+$/.test(s.id)),'enterprise_checkout_subscription_mismatch');
  const blocking=subs.data.filter(s=>['active','trialing','past_due','incomplete'].includes(s.status));check(blocking.length<=1,'enterprise_checkout_replacement_ambiguous');replacement=blocking[0]?.id||null;
 }
 fence();const c=await stripe.customers.retrieve(customer);
 check(c?.object==='customer'&&c.id===customer&&c.deleted!==true&&c.discount===null&&c.balance===0&&typeof c.livemode==='boolean'
  &&(c.discounts==null||Array.isArray(c.discounts)&&c.discounts.length===0)
  &&(c.invoice_credit_balance==null||typeof c.invoice_credit_balance==='object'&&!Array.isArray(c.invoice_credit_balance)&&Object.values(c.invoice_credit_balance).every(v=>v===0))
  &&(c.cash_balance==null||typeof c.cash_balance==='object'&&!Array.isArray(c.cash_balance)
   &&(c.cash_balance.available==null||typeof c.cash_balance.available==='object'&&!Array.isArray(c.cash_balance.available)&&Object.values(c.cash_balance.available).every(v=>v===0))),
 'enterprise_checkout_customer_adjustment_denied');
 let attempt=assertAttempt(await rpc(db,'prepare_enterprise_existing_checkout',{p_agreement:a.id,p_client:a.client_id,p_expected_snapshot:a.template_snapshot,
  p_customer:customer,p_embedded:embedded,p_replacement:replacement,p_config:config}),a,customer,config,embedded);
 const meta=metadataFor(a,t,attempt.source),recurrence=billingInterval==='annual'?'year':'month';
 const priceSpec=[['platform_price_id',t.platform,recurrence,meta.platform,'Enterprise membership','platform_price'],
  ['pool_price_id',t.pool.total_cents,null,meta.pool,`Interview pool (${t.pool.quantity} interviews)`,'pool_price']];
 const pair={};
 for(const [field,amount,rec,metadata,name,suffix]of priceSpec){
  let p;if(attempt.prices)p=await effect(attempt.source,()=>stripe.prices.retrieve(attempt.prices[field]));
  else {try{p=await effect(attempt.source,()=>stripe.prices.create({currency:'usd',unit_amount:amount,...(rec?{recurring:{interval:rec,interval_count:1,usage_type:'licensed'}}:{}),
   product_data:{name},metadata},{idempotencyKey:`${key}:${suffix}`}));}catch(e){if(e?.code==='enterprise_checkout_window_closed')throw e;fail('enterprise_checkout_price_ack_unknown',503);}}
  await verifyPrice(stripe,attempt.source,p,amount,rec,metadata,name);check(p.livemode===c.livemode,'enterprise_checkout_livemode_mismatch');
  if(attempt.prices)check(p.id===attempt.prices[field],'enterprise_checkout_price_mismatch');pair[field]=p.id;
 }
 windowOf(attempt.source);const pricesPinned=await rpc(db,'pin_enterprise_existing_checkout_prices',{p_agreement:a.id,p_client:a.client_id,p_source:attempt.source,p_prices:pair});
 check(isDeepStrictEqual(pricesPinned,{...attempt,prices:pair}),'enterprise_checkout_price_pin_ack_unknown',503);attempt=pricesPinned;
 const w=windowOf(attempt.source),success=`${attempt.source.config.public_backend_base}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${encodeURIComponent(client.id)}`;
 const cancel=frozenRetailCancelUrl({source:{config:attempt.source.config,signer_token_hash:attempt.source.material.signer_token_hash}},cancelUrl);
 if(!attempt.checkout_session_id){
  const body={mode:'subscription',customer,line_items:[{price:pair.platform_price_id,quantity:1},{price:pair.pool_price_id,quantity:1}],allow_promotion_codes:false,
   metadata:meta.session,subscription_data:{metadata:meta.session,billing_cycle_anchor:w.anchor,proration_behavior:'create_prorations'},expires_at:w.expires,
   ...(attempt.source.embedded?{ui_mode:'embedded',return_url:success}:{success_url:success,cancel_url:cancel})};
  let r;try{r=await effect(attempt.source,()=>stripe.checkout.sessions.create(body,{idempotencyKey:key+(attempt.source.embedded?':embedded':'')}));}
  catch(e){if(e?.code==='enterprise_checkout_window_closed')throw e;fail('enterprise_checkout_ack_unknown',503);}
  check(/^cs_[A-Za-z0-9_]+$/.test(r?.id||''),'enterprise_checkout_ack_unknown',503);attempt={...attempt,checkout_session_id:r.id};
 }
 const session=await readSession({stripe,attempt,t,metadata:meta,success,cancel});check(session.livemode===c.livemode,'enterprise_checkout_livemode_mismatch');
 windowOf(attempt.source);const pinned=await rpc(db,'pin_enterprise_existing_checkout_session',{p_agreement:a.id,p_client:a.client_id,p_source:attempt.source,p_prices:attempt.prices,p_session:session.id});
 check(isDeepStrictEqual(pinned,attempt),'enterprise_checkout_pin_ack_unknown',503);
 return {session,fallbackSession:null,checkoutClientSecret:attempt.source.embedded?session.client_secret:null,client,clientEmail:client.email,checkoutMetadata:meta.session,
  interviewPoolId:attempt.source.pool_id,replacesStripeSubscriptionId:attempt.source.replacement_id,replacementPolicy:attempt.source.replacement_id?'immediate_cancel':null,enterpriseAttemptLinked:true};
}
module.exports={createExistingEnterpriseCheckout,dollarsToCents,windowOf,assertAttempt,metadataFor,readSession};
