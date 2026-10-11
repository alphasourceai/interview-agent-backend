'use strict';
// Real private Unix-socket PostgreSQL + actual scope/quote/source services. Fake
// Auth and handoff ONLY; no hosted DB, delivery, provider, API or paid access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,spawn}=require('node:child_process'),{test,before,after}=require('node:test');
const {createMembershipSalesQuoteScopeService}=require('../src/services/membershipSalesQuoteScopes');
const {createMembershipQuoteDraftService}=require('../src/services/membershipQuoteDrafts');
const {createMembershipSalesProspectService}=require('../src/services/membershipSalesProspects');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const {buildRetailOffer,listRetailOffers}=require('../src/services/membershipOffers');
const enabled=process.env.MEMBERSHIP_V2_DISPOSABLE==='true',options={skip:!enabled};
const socket=process.env.PGHOST||'',port=process.env.PGPORT||'55440',PG='/opt/homebrew/opt/postgresql@17/bin/';
const database=`alphascreen_sales_prospects_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const rep='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const buyer={company_legal_name:'Cedar Vale (Synthetic)',company_dba:null,buyer_first_name:'Demo',buyer_last_name:'Buyer',
  buyer_email:'buyer@example.invalid',buyer_phone:null,buyer_title:null};
let baseline;
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const tokenHash=(id,token)=>hash(`sales-email-link-v1\n${id}\n${token}`);
function args(){return ['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-d',database];}
function run(statement){return spawnSync(`${PG}psql`,[...args(),'-c',statement],{encoding:'utf8'});}
function sql(statement){const r=run(statement);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function literal(v){return v===null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
  typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;}
function denied(statement,re){const r=run(statement);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function asyncSQL(statement){let out='',err='';const child=spawn(`${PG}psql`,[...args(),'-c',statement]);
  const done=new Promise((resolve,reject)=>{child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);
    child.on('error',reject);child.on('close',status=>resolve({status,out:out.trim(),err}));});return {child,done};}
function snapshot(){return sql(`select jsonb_build_object('parents',(select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in ('sales_reps'::regclass,'membership_v2_sales_quote_scopes'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'public_purchase_intents'::regclass,'membership_agreements'::regclass)),
  'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'def',pg_get_constraintdef(oid)) order by conname) from pg_constraint
    where conrelid in ('sales_reps'::regclass,'membership_v2_sales_quote_scopes'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'public_purchase_intents'::regclass,'membership_agreements'::regclass)));`);}
function serviceDB(hooks={}){return {from(table){return {
  async insert(row){const r=run(`set role service_role;insert into ${table}(${Object.keys(row).join(',')}) values(${Object.values(row).map(literal).join(',')});`);
    return {error:r.status?{code:'SQLERR',message:'synthetic SQL error'}:null};},
  select(columns){const filters={};const q={eq(k,v){filters[k]=v;return q;},is(k,v){filters[k]=v;return q;},async maybeSingle(){
    const where=Object.entries(filters).map(([k,v])=>v===null?`${k} is null`:`${k}=${literal(v)}`).join(' and ');
    const r=run(`set role service_role;select row_to_json(t) from (select ${columns} from ${table} where ${where}) t;`);
    const result={data:r.stdout.trim()?JSON.parse(r.stdout):null,error:r.status?{code:'SQLERR',message:'synthetic SQL error'}:null};
    if(hooks.afterRead)await hooks.afterRead(table,filters,result);return result;}};return q;}
};},async rpc(name,params){if(hooks.beforeRPC){const result=await hooks.beforeRPC(name,params);if(result)return result;}
  const ordered={membership_v2_reserve_sales_quote_scope:['p_actor','p_key_hash','p_fingerprint'],
    membership_v2_register_sales_prospect:['p_id','p_actor','p_scope','p_quote','p_quote_digest','p_previous','p_buyer','p_canonical','p_fingerprint','p_token_hash'],
    membership_v2_verify_sales_email:['p_source','p_token_hash']}[name];assert.ok(ordered,name);
  const r=run(`set role service_role;select coalesce(json_agg(t),'[]'::json) from public.${name}(${ordered.map(k=>literal(params[k])).join(',')}) t;`);
  let result;if(r.status){const found=r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);
    result={error:{code:found?.[1]||'SQLERR',message:found?.[2]||'synthetic SQL error'}};}
  else result={data:JSON.parse(r.stdout),error:null};
  if(hooks.afterRPC)return hooks.afterRPC(name,params,result);return result;
}};}
function registerSQL(p){return `public.membership_v2_register_sales_prospect(${['p_id','p_actor','p_scope','p_quote','p_quote_digest','p_previous','p_buyer','p_canonical','p_fingerprint','p_token_hash'].map(k=>literal(p[k])).join(',')})`;}
async function fixture(actor=rep,hooks={},handoffFailure=false){
  let authCalls=0,offset=0;const captured=[],rpcs=[];const db=serviceDB({...hooks,afterRPC:async(name,p,r)=>{rpcs.push({name,p:structuredClone(p),result:r});
    return hooks.afterRPC?hooks.afterRPC(name,p,r):r;}});
  const auth={getUser:async()=>{authCalls++;if(hooks.authError && hooks.authError(authCalls))return {error:{message:'synthetic revoked'}};
    return {data:{user:{id:actor,email:'rep@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',is_anonymous:false}}};}};
  const scopes=createMembershipSalesQuoteScopeService({db,auth});
  const ctx=await scopes.createScope({accessToken:'synthetic-test-token'},{idempotencyKey:crypto.randomBytes(16).toString('hex')});
  const subject={accessToken:'synthetic-test-token',scopeId:ctx.scope_id};
  const quotes=createMembershipQuoteDraftService({db,authorizeScope:scopes.authorizeScope,now:()=>new Date(Date.now()+offset).toISOString()});
  const service=createMembershipSalesProspectService({db,authorizeScope:scopes.authorizeScope,now:()=>Date.now()+offset,
    catalog:hooks.catalog,
    handoffVerification:async item=>{captured.push(item);if(handoffFailure)throw new Error('secret transport detail');}});
  async function quote(choice={}){return quotes.createQuote(subject,{planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION,...choice});}
  async function create(previous=null,changed={},choice={}){const q=await quote(choice);
    return service.createProspect(subject,{quoteId:q.quote.quote_id,expectedSourceId:previous,buyer:{...buyer,...changed}});}
  return {db,ctx,subject,quotes,service,captured,rpcs,quote,create,setOffset:v=>offset=v,authCalls:()=>authCalls};
}
before(()=>{
  if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
  const c=spawnSync(`${PG}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);
  sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key,status text);
    create table membership_agreements(id uuid primary key,client_id uuid references clients(id),status text);
    create table public_purchase_intents(id uuid primary key,client_id uuid references clients(id),protocol text,selected_billing_cadence text);
    insert into auth.users values('${rep}'),('${other}');insert into clients values(gen_random_uuid(),'active');
    insert into membership_agreements values(gen_random_uuid(),null,'signed');insert into public_purchase_intents values(gen_random_uuid(),null,'fenced_v2','annual');
    grant usage on schema public,auth to anon,authenticated,service_role;grant select on membership_agreements,public_purchase_intents to service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  const sales=fs.readFileSync(path.join(root,'20260918195401_sales_workspace.sql'),'utf8');sql(sales.slice(0,sales.indexOf('alter table public.public_purchase_intents')));
  sql(`alter table sales_reps enable row level security;revoke all on sales_reps from public,anon,authenticated,service_role;
    grant select,update on sales_reps to service_role;insert into sales_reps(user_id,email,display_name)
      values('${rep}','rep@example.invalid','Synthetic Rep'),('${other}','other@example.invalid','Synthetic Other');`);
  for(const file of ['20261011163625_membership_v2_contract_store.sql','20261011194051_membership_v2_quote_drafts.sql',
    '20261011201754_membership_v2_sales_quote_scopes.sql','20261011211123_membership_v2_sales_prospects.sql']){
    if(file.includes('sales_prospects'))baseline=snapshot();const r=spawnSync(`${PG}psql`,[...args(),'-f',path.join(root,file)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
});
after(()=>{if(!enabled)return;const d=spawnSync(`${PG}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(d.status,0,d.stderr);});

test('all12 actual quotes bind buyer, original rep and canonical digest; no token in response/store',options,async()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments']){
    const f=await fixture(),r=await f.create(null,{company_legal_name:'Café 🚀 Demo',buyer_email:'BUYER@EXAMPLE.INVALID'},{planKey,commitmentMonths,paymentOption});
    assert.equal(r.source.buyer.buyer_email,'buyer@example.invalid');assert.equal(r.source.original_salesperson_user_id,rep);
    assert.equal(r.email_verified,false);assert.equal(r.signing_enabled,false);assert.equal(r.checkout_enabled,false);
    assert.equal(f.captured.length,1);assert.match(f.captured[0].token,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(r).includes(f.captured[0].token),false);
    assert.equal(sql(`select canonical_source=public.membership_v2_quote_canonical(canonical_source::jsonb)
      and encode(sha256(convert_to(canonical_source,'UTF8')),'hex')=source_fingerprint from membership_v2_sales_prospects where id='${r.source.source_id}';`),'t');
    assert.equal(sql(`select row_to_json(c)::text like '%${f.captured[0].token}%' from membership_v2_sales_email_challenges c where source_id='${r.source.source_id}';`),'f');
  }
});
test('correct email capability verifies exactly bound buyer/quote; replay has identical proof/no duplicate',options,async()=>{
  const f=await fixture(),r=await f.create(),input={sourceId:r.source.source_id,token:f.captured[0].token};
  const first=await f.service.verifyEmail(input),second=await f.service.verifyEmail(input);
  assert.deepEqual(second,first);assert.equal(first.email_verified,true);assert.equal(first.signing_enabled,false);
  assert.equal(first.source.quote_digest,r.source.quote_digest);assert.equal(first.source_fingerprint,r.source_fingerprint);
  assert.equal(sql(`select count(*) from membership_v2_sales_email_proofs where source_id='${input.sourceId}';`),'1');
  assert.deepEqual(await f.service.readProspect(f.subject,input.sourceId),first);
});
test('wrong/unknown/cross-source token produce same generic error, no proof',options,async()=>{
  const a=await fixture(),b=await fixture(),x=await a.create(),y=await b.create();
  for(const input of [{sourceId:x.source.source_id,token:crypto.randomBytes(32).toString('base64url')},
    {sourceId:x.source.source_id,token:b.captured[0].token},{sourceId:crypto.randomUUID(),token:a.captured[0].token}])
    await assert.rejects(()=>a.service.verifyEmail(input),e=>e.code==='sales_email_denied' && e.status===403);
  assert.equal(sql(`select count(*) from membership_v2_sales_email_proofs where source_id in ('${x.source.source_id}','${y.source.source_id}');`),'0');
});
test('buyer/email or selected offer replacement invalidates old proof/link, preserves immutable history',options,async()=>{
  const f=await fixture(),a=await f.create();await f.service.verifyEmail({sourceId:a.source.source_id,token:f.captured[0].token});
  const b=await f.create(a.source.source_id,{buyer_email:'new@example.invalid'},{planKey:'pro',commitmentMonths:6,paymentOption:'monthly_installments'});
  assert.equal(b.email_verified,false);assert.equal(b.source.previous_source_id,a.source.source_id);
  await assert.rejects(()=>f.service.verifyEmail({sourceId:a.source.source_id,token:f.captured[0].token}),e=>e.code==='sales_email_denied');
  await assert.rejects(()=>f.service.readProspect(f.subject,a.source.source_id),e=>e.code==='sales_prospect_denied');
  assert.equal(sql(`select count(*) from membership_v2_sales_email_proofs where source_id='${a.source.source_id}';`),'1');
});
test('ownership crossing and reused quote never rebind source',options,async()=>{
  const a=await fixture(),b=await fixture(other),q=await a.quote();
  await assert.rejects(()=>b.service.createProspect(b.subject,{quoteId:q.quote.quote_id,expectedSourceId:null,buyer}),e=>e.code==='quote_not_found');
  const r=await a.service.createProspect(a.subject,{quoteId:q.quote.quote_id,expectedSourceId:null,buyer});
  await assert.rejects(()=>b.service.readProspect(b.subject,r.source.source_id),e=>e.code==='sales_prospect_denied');
  await assert.rejects(()=>a.service.createProspect(a.subject,{quoteId:q.quote.quote_id,expectedSourceId:r.source.source_id,buyer:{...buyer,buyer_email:'another@example.invalid'}}),e=>e.code==='sales_prospect_create_failed');
});
test('same expected prior with two actual concurrent replacements has exactly one winner',options,async()=>{
  const f=await fixture(),a=await f.create(),b=await f.create(a.source.source_id),params=f.rpcs.filter(r=>r.name==='membership_v2_register_sales_prospect').at(-1).p;
  const q1=await f.quote(),q2=await f.quote();
  function attempt(q){const p={...params,p_id:crypto.randomUUID(),p_quote:q.quote.quote_id,p_quote_digest:q.quote_digest,p_previous:b.source.source_id,p_token_hash:hash(crypto.randomBytes(32))};
    const doc=JSON.parse(params.p_canonical);Object.assign(doc,{source_id:p.p_id,quote_id:p.p_quote,quote_digest:p.p_quote_digest,previous_source_id:p.p_previous});
    const stable=v=>v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
    p.p_canonical=stable(doc);p.p_fingerprint=hash(p.p_canonical);return p;}
  const results=await Promise.all([q1,q2].map(q=>asyncSQL(`set role service_role;select id from ${registerSQL(attempt(q))};`).done));
  assert.equal(results.filter(r=>r.status===0).length,1);assert.match(results.find(r=>r.status!==0).err,/sales_source_conflict/);
  assert.equal(sql(`select count(*) from membership_v2_sales_prospects where previous_source_id='${b.source.source_id}';`),'1');
});
test('actual concurrent verification creates one unchanged timestamp and one proof',options,async()=>{
  const f=await fixture(),a=await f.create(),p=`public.membership_v2_verify_sales_email('${a.source.source_id}','${tokenHash(a.source.source_id,f.captured[0].token)}')`;
  const results=await Promise.all(Array.from({length:5},()=>asyncSQL(`set role service_role;select verified_at from ${p};`).done));
  results.forEach(r=>assert.equal(r.status,0,r.err));assert.equal(new Set(results.map(r=>r.out)).size,1);
});
test('exact same registration replay does not handoff, change head or create second challenge',options,async()=>{
  const f=await fixture(),r=await f.create(),params=f.rpcs.find(r=>r.name==='membership_v2_register_sales_prospect').p;
  const first=JSON.parse(sql(`set role service_role;select row_to_json(t) from ${registerSQL(params)} t;`));
  const second=JSON.parse(sql(`set role service_role;select row_to_json(t) from ${registerSQL(params)} t;`));assert.deepEqual(first,second);
  assert.equal(f.captured.length,1);assert.equal(sql(`select count(*) from membership_v2_sales_email_challenges where source_id='${r.source.source_id}';`),'1');
  denied(`set role service_role;select * from ${registerSQL({...params,p_token_hash:'a'.repeat(64)})};`,/sales_source_conflict/);
});
test('returned/thrown lost commit recovers same source once but HELDS handoff; definite error does not recover',options,async()=>{
  for(const mode of ['returned','thrown','definite']){
    const f=await fixture(rep,{afterRPC:async(name,p,r)=>{if(name!=='membership_v2_register_sales_prospect')return r;
      if(mode==='thrown')throw new Error('lost synthetic response');return {error:{code:mode==='definite'?'42501':'NETWORK',message:'secret synthetic details'}};}});
    if(mode==='definite')await assert.rejects(()=>f.create(),e=>e.code==='sales_prospect_create_failed' && !e.message.includes('secret'));
    else {const r=await f.create();assert.equal(r.verification_handoff,'held_unknown_commit');assert.equal(r.email_verified,false);}
    assert.equal(f.captured.length,0);assert.equal(f.rpcs.filter(r=>r.name==='membership_v2_register_sales_prospect').length,1);
  }
});
test('failed trusted handoff never claims delivery/proof; callback immutable and token private',options,async()=>{
  const f=await fixture(rep,{},true),r=await f.create();assert.equal(r.verification_handoff,'failed');assert.equal(r.email_verified,false);
  assert.equal(Object.isFrozen(f.captured[0]),true);assert.equal(Object.isFrozen(f.captured[0].buyer),true);
});
test('rep deactivation denies new source, token verification and known existing source',options,async()=>{
  const f=await fixture(),r=await f.create();sql(`update sales_reps set active=false where user_id='${rep}';`);
  try{await assert.rejects(()=>f.service.verifyEmail({sourceId:r.source.source_id,token:f.captured[0].token}),e=>e.code==='sales_email_denied');
    await assert.rejects(()=>f.service.readProspect(f.subject,r.source.source_id),e=>e.code==='sales_prospect_denied');
    denied(`set role service_role;select * from ${registerSQL(f.rpcs.find(r=>r.name==='membership_v2_register_sales_prospect').p)};`,/sales_source_denied/);
  }finally{sql(`update sales_reps set active=true where user_id='${rep}';`);}
});
test('late Auth revocation after source commit prevents handoff and browser response',options,async()=>{
  let revoke=false;const f=await fixture(rep,{authError:()=>revoke,afterRPC:async(name,p,r)=>{if(name==='membership_v2_register_sales_prospect')revoke=true;return r;}});
  await assert.rejects(()=>f.create(),e=>e.code==='sales_prospect_denied');assert.equal(f.captured.length,0);
  const p=f.rpcs.find(r=>r.name==='membership_v2_register_sales_prospect').p;assert.equal(sql(`select count(*) from membership_v2_sales_prospects where id='${p.p_id}';`),'1');
});
test('expired quote held by adapter and actual registration; DB challenge expiry independently denies token',options,async()=>{
  const f=await fixture();f.setOffset(-30*60000);const q=await f.quote();f.setOffset(0);
  await assert.rejects(()=>f.service.createProspect(f.subject,{quoteId:q.quote.quote_id,expectedSourceId:null,buyer}),e=>e.code==='sales_prospect_denied');
  const g=await fixture();g.setOffset(-30*60000+1500);const near=await g.quote();g.setOffset(0);
  const r=await g.service.createProspect(g.subject,{quoteId:near.quote.quote_id,expectedSourceId:null,buyer});
  sql('select pg_sleep(1.6);');
  denied(`set role service_role;select * from public.membership_v2_verify_sales_email('${r.source.source_id}','${tokenHash(r.source.source_id,g.captured[0].token)}');`,/sales_email_denied/);
});
test('populated RLS/grants/invoker searches, parent invariance and no client/contract/access changes',options,()=>{
  assert.equal(snapshot(),baseline);assert.equal(sql('select status from clients;'),'active');
  assert.equal(sql('select protocol,selected_billing_cadence from public_purchase_intents;'),'fenced_v2|annual');assert.equal(sql('select status from membership_agreements;'),'signed');
  for(const table of ['membership_v2_contracts','membership_v2_initial_receipts','membership_v2_paid_periods'])assert.equal(sql(`select count(*) from ${table};`),'0');
  assert.equal(sql("select count(*) from pg_tables where schemaname='cron';"),'0');
  for(const table of ['membership_v2_sales_prospects','membership_v2_sales_prospect_heads','membership_v2_sales_email_challenges','membership_v2_sales_email_proofs']){
    assert.ok(Number(sql(`set role service_role;select count(*) from ${table};`))>0);
    assert.equal(sql(`select relrowsecurity and relowner<>(select oid from pg_roles where rolname='service_role') from pg_class where oid='${table}'::regclass;`),'t');
    for(const role of ['anon','authenticated']){
      for(const action of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('${role}','${table}','${action}');`),'f');
      assert.equal(sql(`begin;grant select on ${table} to ${role};set local role ${role};select count(*) from ${table};rollback;`),'0');
    }
    for(const action of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('service_role','${table}','${action}');`),
      ['select','insert'].includes(action)||(action==='update'&&table.endsWith('_heads'))?'t':'f');
  }
  for(const signature of ['membership_v2_register_sales_prospect(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,text,text)','membership_v2_verify_sales_email(uuid,text)']){
    assert.equal(sql(`select not prosecdef and proconfig @> array['search_path=pg_catalog'] from pg_proc where oid='${signature}'::regprocedure;`),'t');
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','${signature}','execute');`),'f');
    assert.equal(sql(`select has_function_privilege('service_role','${signature}','execute');`),'t');
  }
});
test('source/challenge/proof mutation and head rollback/delete/truncate are denied even to owner',options,()=>{
  for(const table of ['membership_v2_sales_prospects','membership_v2_sales_email_challenges','membership_v2_sales_email_proofs'])
    for(const action of [`update ${table} set ${table.endsWith('_prospects')?'id=id':'source_id=source_id'};`,`delete from ${table};`,`truncate ${table} cascade;`])denied(action,/immutable_membership_record/);
  for(const action of ['delete from membership_v2_sales_prospect_heads;','truncate membership_v2_sales_prospect_heads;'])denied(action,/immutable_membership_record/);
  denied('update membership_v2_sales_prospect_heads set current_source_id=null;',/invalid_sales_source_transition/);
});
test('names/company/phone-only changes and selection-only changes invalidate prior link independently',options,async()=>{
  for(const change of [{company_legal_name:'New Synthetic Company'},{buyer_first_name:'New Name'},{buyer_phone:'+12025550123'},{}]){
    const f=await fixture(),a=await f.create();const q=change.company_legal_name||change.buyer_first_name||change.buyer_phone?{}:{commitmentMonths:12};
    const b=await f.create(a.source.source_id,change,q);assert.equal(b.email_verified,false);
    await assert.rejects(()=>f.service.verifyEmail({sourceId:a.source.source_id,token:f.captured[0].token}),e=>e.code==='sales_email_denied');
  }
});
test('stale catalog blocks creation/current reads/verification without repricing stored quote',options,async()=>{
  let version=OFFER_VERSION;
  const f=await fixture(rep,{catalog:{currentVersion:()=>version,resolveOffer:(choice,channel)=>buildRetailOffer({...choice,channel}),listOffers:channel=>listRetailOffers({channel})}});
  const a=await f.create(),before=sql(`select canonical_source from membership_v2_sales_prospects where id='${a.source.source_id}';`);
  version='future-unsigned-catalog';
  await assert.rejects(()=>f.service.readProspect(f.subject,a.source.source_id),e=>e.code==='sales_prospect_denied');
  await assert.rejects(()=>f.service.verifyEmail({sourceId:a.source.source_id,token:f.captured[0].token}),e=>e.code==='sales_email_denied');
  await assert.rejects(()=>f.create(),e=>e.code==='sales_prospect_denied');
  assert.equal(sql(`select canonical_source from membership_v2_sales_prospects where id='${a.source.source_id}';`),before);
});
test('actual verify/replace race linearizes once; superseded proof can never be used afterward',options,async()=>{
  let capture=false,replacement;
  const f=await fixture(rep,{beforeRPC:async(name,p)=>{if(capture && name==='membership_v2_register_sales_prospect'){
    replacement=structuredClone(p);return {error:{code:'P0001',message:'sales_source_conflict'}};}}}),a=await f.create();
  capture=true;await assert.rejects(()=>f.create(a.source.source_id),e=>e.code==='sales_prospect_conflict');
  const verify=`public.membership_v2_verify_sales_email('${a.source.source_id}','${tokenHash(a.source.source_id,f.captured[0].token)}')`;
  const attempts=await Promise.all([asyncSQL(`set role service_role;select source_id from ${verify};`).done,
    asyncSQL(`set role service_role;select id from ${registerSQL(replacement)};`).done]);
  if(attempts[0].status!==0)assert.match(attempts[0].err,/sales_email_denied/);
  assert.equal(attempts[1].status,0,attempts[1].err);
  assert.equal(sql(`select current_source_id from membership_v2_sales_prospect_heads where scope_id='${f.ctx.scope_id}';`),replacement.p_id);
  await assert.rejects(()=>f.service.verifyEmail({sourceId:a.source.source_id,token:f.captured[0].token}),e=>e.code==='sales_email_denied');
  await assert.rejects(()=>f.service.readProspect(f.subject,a.source.source_id),e=>e.code==='sales_prospect_denied');
});
test('verify transaction holds rep lock; deactivation waits then prevents further token replay',options,async()=>{
  const f=await fixture(),a=await f.create(),verify=`public.membership_v2_verify_sales_email('${a.source.source_id}','${tokenHash(a.source.source_id,f.captured[0].token)}')`;
  const holding=asyncSQL(`set role service_role;begin;select source_id from ${verify};select pg_sleep(1);commit;`);
  let held=false;for(let i=0;i<30;i++){if(sql("select exists(select 1 from pg_locks where relation='sales_reps'::regclass and mode='RowShareLock' and granted);")==='t'){held=true;break;}}
  assert.equal(held,true);
  const change=asyncSQL(`set role service_role;update sales_reps set active=false where user_id='${rep}';`);
  let blocked=false;for(let i=0;i<30;i++){if(sql("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%update sales_reps set active=false%');")==='t'){blocked=true;break;}}
  assert.equal(blocked,true);assert.equal((await holding.done).status,0);assert.equal((await change.done).status,0);
  try{denied(`set role service_role;select * from ${verify};`,/sales_email_denied/);}finally{sql(`update sales_reps set active=true where user_id='${rep}';`);}
});
test('malformed buyer/canonical/token inputs roll back source/challenge/head atomically',options,async()=>{
  const f=await fixture(),a=await f.create(),original=f.rpcs.find(r=>r.name==='membership_v2_register_sales_prospect').p;
  const q=await f.quote(),base={...original,p_id:crypto.randomUUID(),p_quote:q.quote.quote_id,p_quote_digest:q.quote_digest,p_previous:a.source.source_id};
  const doc=JSON.parse(original.p_canonical);Object.assign(doc,{source_id:base.p_id,quote_id:base.p_quote,quote_digest:base.p_quote_digest,previous_source_id:base.p_previous});
  base.p_canonical=canonical(doc);base.p_fingerprint=hash(base.p_canonical);
  const counts=sql(`select (select count(*) from membership_v2_sales_prospects),(select count(*) from membership_v2_sales_email_challenges);`);
  for(const change of [{p_canonical:'{}'},{p_buyer:{...buyer,verified:true}},{p_buyer:{...buyer,buyer_email:'bad@example.invalid\ncc:any@example.invalid'}},
    {p_token_hash:'not-a-hash'},{p_actor:other},{p_quote_digest:'a'.repeat(64)}])
    denied(`set role service_role;select * from ${registerSQL({...base,...change})};`,/check constraint|sales_source_denied/);
  assert.equal(sql(`select (select count(*) from membership_v2_sales_prospects),(select count(*) from membership_v2_sales_email_challenges);`),counts);
  assert.equal(sql(`select current_source_id from membership_v2_sales_prospect_heads where scope_id='${f.ctx.scope_id}';`),a.source.source_id);
});
