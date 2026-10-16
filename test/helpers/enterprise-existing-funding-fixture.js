'use strict';
// Injected provider/native reads are NOT SQL signing, cash or hosted acceptance.
const {fixture:T,TOKEN,config}=require('./enterprise-existing-checkout-fixture');
const paidFixture=require('./enterprise-pool-payment-fixture');
const {metadataFor}=require('../../src/services/existingEnterpriseCheckoutAttempt');
const {enterprisePoolCheckoutQuote}=require('../../src/services/enterprisePoolSnapshot');
const {validateEnterpriseSettings}=require('../../src/services/enterpriseSettings');
const clone=v=>structuredClone(v);
module.exports=function fixture({cadence='monthly',embedded=false,platformAmount=7000,clientLegalName=null}={}){
 const f=T({cadence,embedded,clientLegalName}),{a,client,seal,db}=f;
 const b=Date.parse('2026-10-01T12:00:00.000Z'),signed=new Date(b-1000).toISOString(),paid=b/1000+3600,observed=b+2*86400000;
 a.signed_at=signed;a.template_snapshot.execution.signed_at=signed;seal.signed_at=signed;seal.execution.signed_at=signed;
 a.auto_renew=true;a.agreement_expires_at=new Date(b+7*86400000).toISOString();
 const poolid='10000000-0000-0000-0000-000000000001',v=a.template_snapshot.values,o=v.pool_offer_snapshot;
 const material={agreement_id:a.id,client_id:a.client_id,customer_id:client.stripe_customer_id,template_snapshot:clone(a.template_snapshot),
  template_version:a.template_version,membership_tier:a.membership_tier,billing_option:a.billing_option,auto_renew:a.auto_renew,
  signer_token_hash:a.signer_token_hash,agreement_expires_at:a.agreement_expires_at,execution_seal:clone(seal)};
 const source={version:'enterprise_existing_pending_v1',material,pool_id:poolid,created_at:new Date(b).toISOString(),
  expires_at:new Date(b+86400000-1000).toISOString(),embedded,replacement_id:null,config:clone(config)};
 Object.assign(a,{enterprise_checkout_source:source,enterprise_checkout_pool_id:poolid,
  enterprise_checkout_prices:{platform_price_id:'price_platform',pool_price_id:'price_pool'},checkout_session_id:'cs_synthetic',
  checkout_status:'pending_payment',checkout_created_at:source.created_at,checkout_paid_at:null,replaces_stripe_subscription_id:null,replacement_policy:null});
 const pool={id:poolid,agreement_id:a.id,client_id:a.client_id,quantity_purchased:o.quantity,unit_price_cents:o.unit_price_cents,
  discount_pct:o.automatic_discount_percent,total_cents:o.net_cents,offer_snapshot:clone(o),offer_digest:v.pool_offer_digest,
  status:'pending',paid_at:null,stripe_checkout_session_id:a.checkout_session_id,stripe_payment_intent_id:null};
 db.tables.client_interview_pools=[pool];
 const p=paidFixture({platformAmount,platformCents:99999,platformInterval:cadence==='annual'?'year':'month'});
 for(const obj of [p.checkout,p.subscription,p.invoice,p.paymentIntent,p.charge]){obj.created=b/1000;obj.customer=client.stripe_customer_id;}
 for(const obj of [p.subscription.items.data[0].price,p.invoice.lines.data[0].price,p.invoice.lines.data[1].price,
  ...p.checkoutLines.data.map(x=>x.price)])obj.created=b/1000;
 p.invoice.status_transitions.paid_at=paid;p.observedAt=observed/1000;
 const meta=metadataFor(a,{pool:enterprisePoolCheckoutQuote(v),platform:99999,settings:validateEnterpriseSettings(v,{planTier:'enterprise'}).settings},source);
 const prices={price_platform:p.subscription.items.data[0].price,price_pool:p.invoice.lines.data[1].price};
 prices.price_platform.metadata=clone(meta.platform);prices.price_pool.metadata=clone(meta.pool);
 for(const l of [...p.subscription.items.data,...p.invoice.lines.data,...p.checkoutLines.data])l.price=clone(prices[l.price.id]);
 delete p.subscription.discounts;delete p.subscription.items.data[0].discounts;
 p.subscription.items.data[0].object='subscription_item';
 for(const l of p.invoice.lines.data){delete l.invoice;l.discount_amounts=null;l.discounts=null;}
 p.invoice.discounts=null;p.invoice.total_discount_amounts=null;p.charge.refunds=null;delete p.charge.dispute;
 Object.assign(p.checkout,{metadata:clone(meta.session),ui_mode:embedded?'embedded':'hosted',allow_promotion_codes:false,
  expires_at:Math.floor(Date.parse(source.expires_at)/1000),success_url:embedded?null:`${config.public_backend_base}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${client.id}`,
  return_url:embedded?`${config.public_backend_base}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${client.id}`:null,
  cancel_url:embedded?null:`${config.public_sign_base}/membership-agreement/sign/${TOKEN}`});
 p.subscription.metadata=clone(meta.session);p.subscription.billing_cycle_anchor=Date.parse('2026-11-01T00:00:00.000Z')/1000;
 const calls=[];
 const read=(kind,fn)=>async(...args)=>{calls.push({kind,args:clone(args)});if(f.onRead)await f.onRead(kind,args);return clone(fn(...args));};
 const list=data=>({object:'list',has_more:false,data});
 const stripe={getApiField:k=>k==='version'?'2023-10-16':undefined,
  accounts:{retrieve:read('account',()=>p.account)},customers:{retrieve:read('customer',()=>({id:client.stripe_customer_id,object:'customer',livemode:false,discount:null,balance:0}))},
  checkout:{sessions:{retrieve:read('checkout',()=>p.checkout),listLineItems:read('checkoutLines',()=>p.checkoutLines)}},
  subscriptions:{retrieve:read('subscription',()=>p.subscription)},subscriptionItems:{list:read('subscriptionItems',()=>p.subscription.items)},
  invoices:{retrieve:read('invoice',()=>p.invoice),list:read('invoices',()=>list([p.invoice])),listLineItems:read('invoiceLines',()=>p.invoice.lines)},
  prices:{retrieve:read('price',key=>prices[key])},paymentIntents:{retrieve:read('paymentIntent',()=>p.paymentIntent)},
  charges:{retrieve:read('charge',()=>p.charge)},refunds:{list:read('refunds',()=>p.refunds)}};
 return Object.assign(f,{pool,p,prices,calls,stripe,args:{db,stripe,agreementId:a.id,now:()=>observed}});
};
