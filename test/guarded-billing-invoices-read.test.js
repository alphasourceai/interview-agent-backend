'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const express=require('express'),request=require('supertest');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const invoices=[{id:'invoice-synthetic',billing_customer_id:'customer-synthetic',title:'Synthetic platform fee',
  invoice_description:'Historical native row',amount_total_cents:29900,currency:'usd',status:'paid',
  hosted_invoice_url:null,stripe_invoice_id:'in_synthetic_history',created_at:'2026-10-01T12:00:00Z',
  customer_name:'Synthetic Buyer',customer_email:'buyer@example.invalid'}];
const db=createFakeSupabase({admins:[{id:'admin-synthetic',email:'owner@example.invalid',is_active:true}],
  billing_invoices:structuredClone(invoices),billing_customers:[]});
const file=path.join(__dirname,'../src/clients/supabase.js');
require.cache[file]={id:file,filename:file,loaded:true,exports:{supabaseAdmin:db,
  supabaseAnon:{auth:{getUser:async()=>({data:{user:{id:'admin-synthetic',email:'owner@example.invalid'}},error:null})}}}};
// Real guarded SDK proxy, not a stub that lacks an invoices property.
const before=process.env.APP_ENV;process.env.APP_ENV='development';
const router=require('../src/routes/admin/billingRouter');
const guard=require('../src/config/guardedPricingDev');
const app=express();app.use(guard.guardedPricingDevFence);app.use('/admin/billing',router);

test('guarded authenticated invoice history returns native rows with provider IDs without SDK access or native writes',async()=>{
  const response=await request(app).get('/admin/billing/invoices').set('Authorization','Bearer synthetic');
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.items,invoices);
  assert.deepEqual(db.tables.billing_invoices,invoices);
  assert.equal(db.calls.some(c=>['insert','update','upsert','delete'].includes(c.op)),false);
});
test('guarded history still enforces admin authentication and explicit refresh stays typed-held',async()=>{
  assert.equal((await request(app).get('/admin/billing/invoices')).status,401);
  db.calls.length=0;
  const response=await request(app).post('/admin/billing/invoices/sync').set('Authorization','Bearer synthetic');
  assert.equal(response.status,503);assert.equal(response.body.code,'GUARDED_DEV_BILLING_HOLD');
  assert.equal(db.calls.length,0);
});
require('node:test').after(()=>{if(before==null)delete process.env.APP_ENV;else process.env.APP_ENV=before;});
