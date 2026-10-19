'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const express=require('express');
const {readRenewalCommissionPolicy,setRenewalCommissionPolicy}=require('../src/services/salesRenewalCommissionPolicy');
const {createAdminSalesPayrollRouter}=require('../src/routes/admin/salesPayroll');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const ACTOR='11111111-1111-4111-8111-111111111111';

test('empty policy defaults OFF; missing schema is unavailable, never silently ON',async()=>{
  assert.deepEqual(await readRenewalCommissionPolicy(createFakeSupabase()),{enabled:false,version:0,changed_at:null});
  await assert.rejects(readRenewalCommissionPolicy({from(){throw Error('missing table');}}),/policy_unavailable/);
});
test('reads newest version and refuses malformed values',async()=>{
  const db=createFakeSupabase({sales_renewal_commission_policy_events:[{version:1,enabled:true},{version:2,enabled:false}]});
  assert.deepEqual(await readRenewalCommissionPolicy(db),{enabled:false,version:2,changed_at:null});
  await assert.rejects(readRenewalCommissionPolicy(createFakeSupabase({sales_renewal_commission_policy_events:[{version:3,enabled:'false'}]})),/policy_unavailable/);
});
test('confirmation, strict boolean, safe revision and server-supplied actor are required',async()=>{
  let calls=0;
  const db={rpc:async(name,args)=>{calls++;assert.equal(name,'set_sales_renewal_commissions');assert.equal(args.p_actor,ACTOR);return{data:{enabled:true,version:1},error:null};}};
  for(const body of [{enabled:true,expected_version:0},{enabled:'true',confirmed:true,expected_version:0},
    {enabled:true,confirmed:true,expected_version:-1},{enabled:true,confirmed:true,expected_version:0,changed_by:ACTOR}])
    await assert.rejects(setRenewalCommissionPolicy(db,body,ACTOR),/invalid_renewal_commission_confirmation/);
  assert.equal(calls,0);
  assert.deepEqual(await setRenewalCommissionPolicy(db,{enabled:true,confirmed:true,expected_version:0},ACTOR),{enabled:true,version:1,changed_at:null});
  assert.equal(calls,1);
});
test('stale version yields refresh conflict; provider errors never return saved success',async()=>{
  const body={enabled:false,confirmed:true,expected_version:2};
  await assert.rejects(setRenewalCommissionPolicy({rpc:async()=>({error:{code:'P0001',message:'renewal_commission_policy_changed'}})},body,ACTOR),e=>e.status===409);
  await assert.rejects(setRenewalCommissionPolicy({rpc:async()=>({error:{message:'unknown outcome'}})},body,ACTOR),/unavailable/);
});
test('existing parent admin guard remains mounted; setting mutation is POST and actor is authenticated user',async()=>{
  const fs=require('node:fs');
  assert.match(fs.readFileSync(require.resolve('../src/routes/admin/index'),'utf8'),/router.use\('\/sales-payroll', requireAuth, requireAdmin/);
  const db=createFakeSupabase();let args;
  db.rpc=async(_name,input)=>{args=input;return{data:{enabled:true,version:1},error:null};};
  const app=express();app.use(express.json());
  app.use('/payroll',(req,_res,next)=>{req.user={id:ACTOR};next();},createAdminSalesPayrollRouter({db}));
  assert.equal((await request(app).get('/payroll/renewal-commissions')).body.enabled,false);
  assert.equal((await request(app).post('/payroll/renewal-commissions').send({enabled:true,expected_version:0})).status,422);
  const saved=await request(app).post('/payroll/renewal-commissions').send({enabled:true,confirmed:true,expected_version:0});
  assert.equal(saved.status,200);assert.equal(saved.body.enabled,true);assert.equal(args.p_actor,ACTOR);
});
