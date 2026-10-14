'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeExistingRetailReplacementCancellation: execute } = require('../src/services/existingRetailReplacementCancellation');

const agreementId='11111111-1111-4111-8111-111111111111';
const intentId='22222222-2222-4222-8222-222222222222';
const claimKey='SYNTHETIC_CLAIM_KEY_0123456789abcdef0123456789abcdef';
const request={ version:'retail_existing_replacement_cancel_v1',api_version:'2023-10-16',agreement_id:agreementId,
 client_id:'33333333-3333-4333-8333-333333333333',intent_id:intentId,provider_account_id:'acct_SYNTHETIC',livemode:false,
 customer_id:'cus_SYNTHETIC',source_digest:'a'.repeat(64),funding_receipt_digest:'b'.repeat(64),
 old_subscription_id:'sub_OLD_SYNTHETIC',new_subscription_id:'sub_NEW_SYNTHETIC',
 cancellation:{method:'DELETE',path:'/v1/subscriptions/sub_OLD_SYNTHETIC',parameters:{invoice_now:false,prorate:false},policy:'immediate_cancel'} };
const old=(status='canceled')=>({id:request.old_subscription_id,customer:request.customer_id,currency:'usd',livemode:false,status,
 canceled_at:status==='canceled'?Math.floor(Date.now()/1000):null});
const prepared=(status='active')=>({status:'preflight_verified',request,created_at:'2026-10-14T12:00:00.000000Z',new_subscription:{id:request.new_subscription_id},
 old_subscription:old(status),effect_authorized:false,native_completion:false});
function harness({prior='active',cancelResult=old(),cancelError=null,fresh=old(),rpcError=null,api='2023-10-16',preparedResult=prepared(prior)}={}){
 const calls={cancel:[],retrieve:[],rpc:[],fence:0};
 const stripe={getApiField:key=>key==='version'?api:null,subscriptions:{
  async cancel(...args){calls.cancel.push(args);if(cancelError)throw cancelError;return cancelResult;},
  async retrieve(...args){calls.retrieve.push(args);return fresh;}
 }};
 const db={async rpc(...args){calls.rpc.push(args);if(rpcError)return{data:null,error:rpcError};return{data:{status:'observed',observation:{request,provider_account_id:request.provider_account_id,
   old_subscription:calls.cancel.length?old():old('canceled')}},error:null};}};
 const options={db,stripe,agreementId,intentId,claimKey,assertFence:async()=>{calls.fence++;},prepareExistingRetailReplacement:async()=>preparedResult};
 return{calls,options};
}

test('executes one bounded, no-retry cancellation and records the native observation',async()=>{
 const h=harness();const result=await execute(h.options);
 assert.deepEqual(result,{status:'observed'});assert.equal(h.calls.cancel.length,1);assert.deepEqual(h.calls.cancel[0][0],request.old_subscription_id);
 assert.deepEqual(h.calls.cancel[0][1],{invoice_now:false,prorate:false});assert.equal(h.calls.cancel[0][2].maxNetworkRetries,0);
 assert.equal(h.calls.cancel[0][2].timeout,12000);
 assert.equal(h.calls.retrieve.length,0);assert.equal(h.calls.rpc.length,1);assert.equal(h.calls.rpc[0][0],'record_retail_existing_replacement_canceled');
 assert.ok(h.calls.fence>=3);
});

test('ambiguous DELETE result is resolved by exactly one fresh GET; it is never blindly retried',async()=>{
 const h=harness({cancelError:new Error('provider detail must not escape'),fresh:old('canceled')});
 assert.deepEqual(await execute(h.options),{status:'observed'});assert.equal(h.calls.cancel.length,1);assert.equal(h.calls.retrieve.length,1);assert.equal(h.calls.rpc.length,1);
 assert.deepEqual(h.calls.retrieve[0],[request.old_subscription_id,{}, {maxNetworkRetries:0,timeout:12000}]);
});

test('unconfirmed provider state remains retryable and writes no cancellation fact',async()=>{
 const h=harness({cancelResult:{object:'subscription',id:'sub_OTHER'},fresh:old('active')});
 await assert.rejects(execute(h.options),e=>e.status===503&&e.code==='retail_replacement_cancel_unconfirmed');
 assert.equal(h.calls.cancel.length,1);assert.equal(h.calls.retrieve.length,1);assert.equal(h.calls.rpc.length,0);
});

test('pre-canceled old subscription records verified fact without another DELETE',async()=>{
 const h=harness({prior:'canceled'});assert.deepEqual(await execute(h.options),{status:'observed'});
 assert.equal(h.calls.cancel.length,0);assert.equal(h.calls.retrieve.length,0);assert.equal(h.calls.rpc.length,1);
});

test('no-replacement path has no provider or database mutation',async()=>{
 const h=harness({preparedResult:{status:'no_replacement',request:null,native_completion:false,effect_authorized:false}});
 assert.deepEqual(await execute(h.options),{status:'no_replacement'});assert.equal(h.calls.cancel.length,0);assert.equal(h.calls.retrieve.length,0);assert.equal(h.calls.rpc.length,0);
});

test('API version mismatch fails closed before preflight or provider mutation',async()=>{
 const h=harness({api:'2025-01-01'});await assert.rejects(execute(h.options),e=>e.status===503&&e.code==='retail_replacement_cancel_precondition_unknown');
 assert.equal(h.calls.cancel.length,0);assert.equal(h.calls.retrieve.length,0);assert.equal(h.calls.rpc.length,0);
});

test('lost activation claim maps to the bounded retry sentinel without leaking database details',async()=>{
 const h=harness({rpcError:{message:'retail_cancel_observation_claim_denied',details:'synthetic sensitive detail'}});
 await assert.rejects(execute(h.options),e=>e.status===503&&e.code==='public_purchase_activation_guard_lost'&&!e.message.includes('sensitive'));
 assert.equal(h.calls.cancel.length,1);assert.equal(h.calls.rpc.length,1);
});
