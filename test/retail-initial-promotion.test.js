'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {verifyInitialPromotion:verify,readInitialPromotion:read}=require('../src/services/retailInitialPromotion');
const nowEpoch=2000000000;
const offer=(role=false,platform=44900,roleCents=35900)=>({payment_option:'monthly_installments',platform_payment_cents:platform,
 first_role_prepay:{selected:role,amount_cents:roleCents},initial_payment_cents:platform+(role?roleCents:0)});
function promotion(){return{object:'promotion_code',id:'promo_SYNTHETIC',active:true,livemode:false,customer:null,expires_at:null,
 max_redemptions:null,times_redeemed:0,
 restrictions:{first_time_transaction:false,minimum_amount:null,minimum_amount_currency:null},
 coupon:{object:'coupon',id:'SYNTHETIC',valid:true,livemode:false,percent_off:10,amount_off:null,currency:null,
  duration:'once',duration_in_months:null,redeem_by:null,max_redemptions:null,times_redeemed:0}};}
const options=(o=offer())=>({promotionId:'promo_SYNTHETIC',offer:o,nowEpoch});
test('positive percent/fixed monthly promotions preserve duration and accepted line amounts',()=>{
 for(const role of [false,true])for(const duration of ['once','repeating','forever']){
  const p=promotion(),o=offer(role);p.coupon.duration=duration;p.coupon.duration_in_months=duration==='repeating'?3:null;
  assert.equal(verify(p,options(o)).minimumNetCents,o.initial_payment_cents*.9);
  p.coupon.percent_off=null;p.coupon.amount_off=100;p.coupon.currency='usd';
  assert.equal(verify(p,options(o)).minimumNetCents,o.initial_payment_cents-100);
  assert.equal(verify(p,options(o)).coupon.duration,duration);
 }
});
test('safe per-line cent ceilings refuse penny ambiguity and never count an unselected role',()=>{
 const p=promotion();p.coupon.percent_off=50;
 assert.throws(()=>verify(p,options(offer(false,1))),{code:'retail_checkout_zero_initial_payment_denied'});
 assert.throws(()=>verify(p,options(offer(true,1,1))),{code:'retail_checkout_zero_initial_payment_denied'});
 assert.equal(verify(p,options(offer(true,3,3))).minimumNetCents,2);
 p.coupon.percent_off=null;p.coupon.amount_off=44900;p.coupon.currency='usd';
 assert.throws(()=>verify(p,options()),{code:'retail_checkout_zero_initial_payment_denied'});
 assert.equal(verify(p,options(offer(true))).minimumNetCents,35900);
});
test('unknown, zero, expired, restricted and incompatible provider shapes refuse',()=>{
 const mutations=[p=>p.id='promo_OTHER',p=>p.active=false,p=>p.object='other',p=>p.customer={object:'customer',id:'cus_OTHER',deleted:true},p=>p.expires_at=nowEpoch,
  p=>p.coupon.percent_off=100,p=>p.coupon.percent_off=101,p=>p.coupon.percent_off=0,p=>p.coupon.percent_off=10.001,
  p=>p.coupon.amount_off=1,p=>p.coupon.currency='usd',p=>p.coupon.valid=false,p=>p.coupon.deleted=true,p=>p.coupon.livemode=true,
  p=>p.coupon.duration='trial',p=>p.coupon.duration='repeating',p=>p.coupon.redeem_by=nowEpoch,p=>p.coupon='SYNTHETIC',
  p=>p.coupon.applies_to={products:['prod_OTHER']},p=>p.coupon.applies_to=null,p=>p.coupon.currency_options={usd:{amount_off:1}},
  p=>p.restrictions.first_time_transaction=true,p=>p.restrictions.minimum_amount=90000,
  p=>p.max_redemptions=1&& (p.times_redeemed=1),p=>p.coupon.max_redemptions=1&& (p.coupon.times_redeemed=1),
  p=>{p.promotion={coupon:p.coupon};delete p.coupon},p=>delete p.expires_at,p=>delete p.coupon.redeem_by];
 for(const mutate of mutations){const p=promotion();mutate(p);assert.throws(()=>verify(p,options()),e=>
  !(e instanceof TypeError)&&typeof e.code==='string'&&e.code.startsWith('retail_checkout_'));}
});
test('USD amount override and minimum restriction use the actual currency option, never the cheaper default',()=>{
 const p=promotion();p.coupon.percent_off=null;p.coupon.amount_off=1;p.coupon.currency='eur';
 p.coupon.currency_options={usd:{amount_off:44900}};
 assert.throws(()=>verify(p,options()),{code:'retail_checkout_zero_initial_payment_denied'});
 p.coupon.currency_options.usd.amount_off=100;
 assert.equal(verify(p,options()).minimumNetCents,44800);
 p.restrictions.currency_options={usd:{minimum_amount:44901}};assert.throws(()=>verify(p,options()));
 p.restrictions.currency_options.usd.minimum_amount=44900;assert.equal(verify(p,options()).minimumNetCents,44800);
});
test('customer restriction is projected for a pre-write resolved-customer match, never treated as unrestricted',()=>{
 for(const value of ['cus_SYNTHETIC',{object:'customer',id:'cus_SYNTHETIC'}]) {
  const p=promotion();p.customer=value;assert.equal(verify(p,options()).customerId,'cus_SYNTHETIC');
 }
});
test('fixed amount must be positive USD and leave a positive accepted subtotal',()=>{
 for(const [amount,currency,allowed] of [[1,'usd',true],[44899,'usd',true],[44900,'usd',false],[44901,'usd',false],
 [0,'usd',false],[1,'eur',false],['1','usd',false]]){
  const p=promotion();p.coupon.percent_off=null;p.coupon.amount_off=amount;p.coupon.currency=currency;
  if(allowed)assert.ok(verify(p,options()).minimumNetCents>0);else assert.throws(()=>verify(p,options()));
 }
});
test('read adapter is one exact-ID read, never a plaintext first-entry search or provider write',async()=>{
 const p=promotion(),calls=[];
 const stripe={promotionCodes:{retrieve:async id=>{calls.push(id);return p}}};
 assert.equal((await read({stripe,promotionId:p.id,offer:offer()})).minimumNetCents,40410);
 assert.deepEqual(calls,['promo_SYNTHETIC']);assert.equal(await read({stripe,promotionId:'',offer:offer()}),null);
 await assert.rejects(read({stripe:{},promotionId:p.id,offer:offer()}),{code:'retail_checkout_promotion_unavailable'});
 assert.deepEqual(calls,['promo_SYNTHETIC']);
});
