'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express'),request=require('supertest');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {DEMO_CLIENT_ID,QA_URL,demoFence,safeDemoRequest}=require('../src/services/salesDemo');

test('Overview candidate read passes only the exact QA fence path; real authentication/admin guards remain required',async()=>{
 const priorUrl=process.env.SUPABASE_URL;process.env.SUPABASE_URL=QA_URL;
 const clientPath=require.resolve('../src/clients/supabase');
 const paths=['../src/middleware/auth','../src/middleware/requireAdmin','../src/routes/admin/candidates'].map(require.resolve);
 const saved=[clientPath,...paths].map(p=>require.cache[p]);
 const tables={admins:[{id:'owner',email:'admin@example.invalid',is_active:true}],candidates:[]};
 const db=createFakeSupabase(tables);
 db.auth={getUser:async token=>({data:{user:token==='invalid'?null:{id:token,email:token==='admin'?'admin@example.invalid':'rep@example.invalid',
  ...(token==='demo'?{app_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}}:{})}},error:null})};
 require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabaseAdmin:db,supabaseAnon:db}};
 for(const p of paths)delete require.cache[p];
 try{
  const app=express();app.use(express.json());app.use(demoFence);app.use('/admin',require(paths[2]));
  const url=`/admin/candidates?client_id=${DEMO_CLIENT_ID}`;
  assert.equal((await request(app).get(url)).status,401);
  assert.equal((await request(app).get(url).set('Authorization','Bearer invalid')).status,401);
  assert.equal((await request(app).get(url).set('Authorization','Bearer rep')).status,403);
  assert.equal((await request(app).get(url).set('Authorization','Bearer demo')).status,403);
  const result=await request(app).get(url).set('Authorization','Bearer admin');
  assert.equal(result.status,200);assert.deepEqual(result.body.candidates,[]);
  assert.equal((await request(app).head(url).set('Authorization','Bearer admin')).status,200);
  assert.equal((await request(app).get('/api'+url).set('Authorization','Bearer admin')).status,403);
  for(const method of ['post','delete','patch','put'])assert.equal((await request(app)[method](url).set('Authorization','Bearer admin')).status,403);
  for(const path of ['/admin/candidates/export','/admin/candidates/other','/admin/billing','/admin/sales-team'])
   assert.equal((await request(app).get(path+`?client_id=${DEMO_CLIENT_ID}`).set('Authorization','Bearer admin')).status,403);
  // The restricted demo principal allowlist is not broadened to any admin read.
  assert.equal(safeDemoRequest({method:'GET',originalUrl:url}),false);
  process.env.SUPABASE_URL='https://not-qa.supabase.co';
  assert.equal((await request(app).get(url).set('Authorization','Bearer admin')).status,404);
 }finally{
  [clientPath,...paths].forEach((p,i)=>{if(saved[i])require.cache[p]=saved[i];else delete require.cache[p];});
  if(priorUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=priorUrl;
 }
});
