'use strict';
// Differential calculation tests, not native reservation or provider acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),{execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),BASE='ed96fbf7e106198d0fdef5ff2d5157137b87da6a';
for(const [file,exports] of [['src/clients/supabase.js',{supabaseAdmin:{},supabase:{},supabaseAnon:{}}],
  ['src/clients/sendgrid.js',{sendRoleInterviewLimitReachedEmail:async()=>{throw Error('send forbidden');},buildBrandedEmailShell:()=>'',escapeHtml:v=>v}]]) {
  const filename=path.join(ROOT,file);require.cache[filename]={id:filename,filename,loaded:true,exports};
}
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {allocateInterviews:current,allocateInterviewRows:pure}=require('../src/services/interviewAllocation');
const frozenPaths=['src/services/interviewAllocation.js','src/services/roleInterviewAvailability.js','src/services/billingModel.js'];
const frozenModules=new Map();
function frozen(file) {
  if(frozenModules.has(file))return frozenModules.get(file).exports;
  const filename=path.join(ROOT,file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  frozenModules.set(file,m);const local=Module.createRequire(filename);
  m.require=spec=>{
    const resolved=local.resolve(spec),relative=path.relative(ROOT,resolved);
    return frozenPaths.includes(relative)?frozen(relative):local(spec);
  };
  m._compile(execFileSync('git',['show',`${BASE}:${file}`],{cwd:ROOT,encoding:'utf8'}),filename);return m.exports;
}
const old=frozen('src/services/interviewAllocation.js').allocateInterviews;
const resolve=frozen('src/services/billingModel.js').resolveBillingModel;
const ASOF='2026-09-01T00:00:00.000Z';
const clone=v=>structuredClone(v);
function base(model='usage',included=0,fee=2500) {
  return {clients:[{id:'payer',parent_client_id:null},{id:'child',parent_client_id:'payer',entity_label:'Synthetic Child'}],
    client_plan_settings:[{client_id:'payer',plan_tier:model==='usage'?'enterprise':model==='rollover'?'pro':'basic',
      billing_model:model,included_interviews_per_role:included,usage_interview_fee_cents:fee}],
    roles:[{id:'role_a',client_id:'payer',title:'Synthetic Role A'},{id:'role_b',client_id:'child',title:'Synthetic Role B'}],
    interviews:[],role_interview_purchases:[],interview_credits:[],client_interview_pools:[]};
}
const iv=(id,role='role_a',client='payer',completed='2026-08-10T00:00:00Z')=>({id,role_id:role,client_id:client,
  status:'completed',completed_at:completed,updated_at:'2026-08-09T00:00:00Z'});
function freeze(v) {if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
async function check(tables,asOf=ASOF) {
  const db0=createFakeSupabase(clone(tables)),db1=createFakeSupabase(clone(tables));
  const expected=await old({db:db0,billingClientId:'payer',asOf}),actual=await current({db:db1,billingClientId:'payer',asOf});
  assert.deepEqual(actual,expected);assert.deepEqual(db1.calls,db0.calls);
  const db=createFakeSupabase(clone(tables)),billing=await resolve({db,clientId:'payer'});
  const input={billingModel:billing.billing_model,includedPerRole:billing.included_interviews_per_role??0,
    usageInterviewFeeCents:billing.usage_interview_fee_cents,asOfIso:new Date(asOf).toISOString(),
    roleRows:tables.roles,interviewRows:tables.interviews,purchaseRows:tables.role_interview_purchases.filter(r=>r.status==='paid'),
    creditRows:tables.interview_credits,poolRows:tables.client_interview_pools.filter(r=>r.client_id==='payer'&&r.status==='paid'),
    entityLabelById:new Map([['child','Synthetic Child']])};
  for(const method of ['set','delete','clear'])Object.defineProperty(input.entityLabelById,method,{value(){throw Error('input map mutation');}});
  freeze(input);
  const snapshot=clone(input),RealDate=Date;let shared;
  global.Date=class extends RealDate{constructor(...args){if(!args.length)throw Error('implicit clock');super(...args);}static now(){throw Error('implicit clock');}};
  try {shared=pure(input);}finally{global.Date=RealDate;}
  assert.deepEqual(shared,expected);assert.deepEqual(input,snapshot);assert.equal(shared.roles,input.roleRows);
  assert.equal(shared.entity_label_by_client,input.entityLabelById);
  assert.notEqual(shared.credits,input.creditRows);assert.notEqual(shared.pools,input.poolRows);
  return shared;
}
test('shared replay preserves own allowances, paid purchases and unknown-role legacy fallback',async()=>{
  for(const model of ['fixed','rollover','usage']) {
    const g=base(model,1,0);g.interviews=[iv('a'),iv('b'),iv('c'),iv('d','unknown')];
    g.role_interview_purchases=[{client_id:'payer',role_id:'role_a',quantity:'1',status:'paid'},
      {client_id:'payer',role_id:'role_a',quantity:999,status:'pending'},
      {client_id:'payer',role_id:'unknown',quantity:99,status:'paid'}];
    const r=await check(g);assert.equal(r.entries[0].source,'own');assert.equal(r.entries[2].source,'usage');
    assert.equal(r.by_role.get('unknown').own_remaining,0);assert.equal(r.usage_interview_fee_cents,0);
  }
});
test('live then revoked credit retains attribution and reduces the source role allowance; expiry boundary exact',async()=>{
  const g=base('rollover',1);g.interviews=[iv('a','role_b','child'),iv('b','role_b','child')];
  g.interview_credits=[{id:'credit_live_then_revoked',client_id:'child',source_role_id:'role_a',quantity:2,
    minted_at:'2026-08-01T00:00:00Z',expires_at:ASOF,revoked_at:'2026-08-20T00:00:00Z'},
    {id:'foreign_credit',client_id:'payer',source_role_id:'role_a',quantity:50,minted_at:'2026-08-01T00:00:00Z',expires_at:ASOF}];
  const r=await check(g);assert.equal(r.entries[1].source,'credit');assert.equal(r.entries[1].source_id,'credit_live_then_revoked');
  assert.equal(r.by_role.get('role_a').drawn_from_revoked,1);assert.equal(r.by_role.get('role_a').own_remaining,0);
  assert.equal(r.totals.credit_balance,0);
  const h=base('rollover',0);h.interviews=[iv('expiry','role_b','child',ASOF)];
  h.interview_credits=[{id:'expired',client_id:'child',source_role_id:'role_a',quantity:5,minted_at:'2026-08-01Z',expires_at:ASOF}];
  assert.equal((await check(h)).entries[0].source,'usage');
});
test('pool waterfall is created_at then id, never paid_at, and preserves positive Enterprise allowance',async()=>{
  const g=base('usage',1);g.interviews=[iv('a'),iv('b'),iv('c'),iv('d')];
  g.client_interview_pools=[{id:'pool_z',client_id:'payer',status:'paid',quantity_purchased:1,created_at:'2026-08-03Z',paid_at:'2026-08-01Z'},
    {id:'pool_b',client_id:'payer',status:'paid',quantity_purchased:1,created_at:'2026-08-02Z',paid_at:'2026-08-04Z'},
    {id:'pool_a',client_id:'payer',status:'paid',quantity_purchased:1,created_at:'2026-08-02Z',paid_at:'2026-08-05Z'}];
  const r=await check(g);assert.deepEqual(r.entries.map(e=>e.source_id),['role_a','pool_a','pool_b','pool_z']);
});
test('legacy coercion skips invalid purchases, zeroes invalid pools/credits and preserves missing completion ordering',async()=>{
  for(const fee of [0,null,'bad']) {
    const g=base('usage',null,fee);g.interviews=[iv('b'),iv('a'),iv('missing','role_b','child',null)];
    g.role_interview_purchases=[{client_id:'payer',role_id:'role_a',quantity:'',status:'paid'},
      {client_id:'payer',role_id:'role_a',quantity:-1,status:'paid'}];
    g.client_interview_pools=[{id:'invalid_pool',client_id:'payer',status:'paid',quantity_purchased:'bad',created_at:'2026-08-01Z'}];
    g.interview_credits=[{id:'invalid_credit',client_id:'child',source_role_id:'role_a',quantity:null}];
    const r=await check(g);assert.equal(r.entries[0].interview_id,'missing');assert.equal(r.entries[0].completed_at,null);
    assert.equal(r.pools[0].quantity_purchased,0);assert.equal(r.credits[0].quantity,0);
    assert.equal(r.usage_interview_fee_cents,fee===0?0:null);
  }
});
test('500 seeded synthetic graphs match exact prior wrapper and all returned maps without mutation or clock reads',async()=>{
  let seed=1729;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const quantities=[0,1,2,5,'3',null,'',-1,1.5,'bad'],models=['fixed','rollover','usage'];
  for(let k=0;k<500;k++) {
    const g=base(models[rand(3)],quantities[rand(10)],quantities[rand(10)]);
    for(let j=0;j<rand(18)+1;j++){const child=rand(2)===1;g.interviews.push({...iv(`iv_${j}`,child?'role_b':'role_a',child?'child':'payer',
      rand(5)===0?null:`2026-08-${String(rand(25)+1).padStart(2,'0')}T00:00:00Z`),has_substantive_response:rand(7)===0?false:undefined});}
    for(let j=0;j<3;j++)g.role_interview_purchases.push({client_id:'payer',role_id:'role_a',quantity:quantities[rand(10)],status:rand(2)?'paid':'pending'});
    for(let j=0;j<3;j++){g.interview_credits.push({id:`credit_${j}`,client_id:rand(2)?'payer':'child',source_role_id:'role_a',quantity:quantities[rand(10)],
      minted_at:'2026-08-01Z',expires_at:rand(2)?ASOF:'2026-08-15Z',revoked_at:rand(2)?null:'2026-08-20Z'});
      g.client_interview_pools.push({id:`pool_${j}`,client_id:'payer',quantity_purchased:quantities[rand(10)],status:'paid',created_at:'2026-08-01Z'});}
    await check(g);
  }
});
test('wrapper invalid/unresolved empties keep exact prior keys and fresh arrays/maps',async()=>{
  for(const args of [{},{db:createFakeSupabase(base())},{db:createFakeSupabase({clients:[]}),billingClientId:'missing'},
    {db:createFakeSupabase({clients:[{id:'payer'}],client_plan_settings:[]}),billingClientId:'payer'}]) {
    const expected=await old(args),actual=await current(args);assert.deepEqual(actual,expected);
    assert.equal(Object.hasOwn(actual,'credit_balance_by_client'),false);
    const repeat=await current(args);assert.notEqual(actual.by_role,repeat.by_role);assert.notEqual(actual.entries,repeat.entries);
  }
});
