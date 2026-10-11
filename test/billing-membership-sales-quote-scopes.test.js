'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');
const crypto=require('node:crypto');
const {createMembershipSalesQuoteScopeService}=require('../src/services/membershipSalesQuoteScopes');
const {createMembershipQuoteDraftService}=require('../src/services/membershipQuoteDrafts');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const rep='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const now=Date.parse('2026-10-11T12:00:00.000Z');
const key='synthetic_scope_key_12345';const subject={accessToken:'synthetic-token'};
const code=(name,status)=>e=>e.code===name && (!status||e.status===status) && e.message===name;
function fixture(){
  const rows=new Map(),quotes=new Map(),calls=[];
  const f={user:{id:rep,email:'rep@example.invalid',is_anonymous:false,email_confirmed_at:'2026-10-01T00:00:00Z'},
    active:new Set([rep,other]),authError:false,grantError:false,rpcMode:null,rpcData:null,readError:false,
    beforeAuth:null,beforeRead:null,authCalls:0,readCalls:0};
  const auth={async getUser(token){calls.push(['auth',token]);f.authCalls++;if(f.beforeAuth)f.beforeAuth(f.authCalls);
    return {data:{user:structuredClone(f.user)},error:f.authError?{message:'private Auth data'}:null};}};
  const db={from(table){calls.push(['table',table]);return {
    async insert(row){assert.equal(table,'membership_v2_quote_drafts');quotes.set(row.id,structuredClone(row));return {error:null};},
    select(){const filters={};const q={eq(k,v){filters[k]=v;return q;},is(k,v){filters[k]=v;return q;},
      async maybeSingle(){
        if(table==='sales_reps')return {data:f.active.has(filters.user_id)?{user_id:filters.user_id,active:true}:null,
          error:f.grantError?{message:'private grant detail'}:null};
        f.readCalls++;if(f.beforeRead)f.beforeRead(f.readCalls);
        calls.push(['read',table,filters]);if(f.readError)return {error:{message:'private DB detail'}};
        const store=table==='membership_v2_quote_drafts'?quotes:rows;
        const row=[...store.values()].find(r=>Object.entries(filters).every(([k,v])=>r[k]===v));
        return {data:row?structuredClone(row):null,error:null};
      }};return q;}
  };},async rpc(name,args){calls.push(['rpc',name,args]);
    assert.equal(name,'membership_v2_reserve_sales_quote_scope');
    if(f.rpcMode==='definite')return {error:{code:'23514',message:'private constraint detail'}};
    if(f.rpcMode==='throw-sql'){const e=Error('private SQL detail');e.code='42501';throw e;}
    if(f.rpcMode==='before')throw Error('private lost connection');
    if(f.rpcMode==='returned-before')return {error:{message:'SECRETTOKENVALUE lost response'}};
    if(!f.active.has(args.p_actor))return {error:{code:'P0001',message:'sales_scope_denied'}};
    let row=[...rows.values()].find(r=>r.issuer_user_id===args.p_actor && r.idempotency_key_hash===args.p_key_hash);
    if(!row){row={id:crypto.randomUUID(),issuer_user_id:args.p_actor,audience:'sales',scope_kind:'manual_prospect',source_verified:false,
      idempotency_key_hash:args.p_key_hash,request_fingerprint:args.p_fingerprint,created_at:new Date(now).toISOString()};rows.set(row.id,row);}
    if(f.rpcMode==='after')throw Error('private lost ack');
    if(f.rpcMode==='returned-after')return {error:{message:'SECRETTOKENVALUE lost response'}};
    if(f.rpcMode==='key-conflict')return {error:{code:'23505',constraint:'membership_v2_sales_scopes_actor_key_unique'}};
    if(f.rpcMode==='wrong-conflict')return {error:{code:'23505',constraint:'membership_v2_sales_quote_scopes_pkey'}};
    return {data:f.rpcData===null?[structuredClone(row)]:structuredClone(f.rpcData),error:null};
  }};
  f.service=createMembershipSalesQuoteScopeService({db,auth,now:()=>now});
  Object.assign(f,{db,auth,rows,quotes,calls});return f;
}
test('dependencies required; no real client/config fallback',()=>{
  assert.throws(()=>createMembershipSalesQuoteScopeService(),code('sales_scope_not_configured',503));
});
test('Auth verified actor owns scope and original attribution; no buyer/source/pay access',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});
  assert.deepEqual(scope,{scope_id:[...f.rows.keys()][0],audience:'sales',issuer_user_id:rep,
    original_salesperson_user_id:rep,client_id:null,billing_owner_user_id:null});
  assert.ok(Object.isFrozen(scope));assert.equal(f.rows.size,1);assert.equal(f.quotes.size,0);
  assert.ok(f.calls.filter(c=>c[0]==='auth').every(c=>c[1]==='synthetic-token'));
  assert.deepEqual(await f.service.authorizeScope({...subject,scopeId:scope.scope_id}),scope);
});
test('same actor/key retries and concurrent calls return one scope; new key creates a separate inert scope',async()=>{
  const f=fixture(),results=await Promise.all(Array.from({length:8},()=>f.service.createScope(subject,{idempotencyKey:key})));
  assert.equal(new Set(results.map(r=>r.scope_id)).size,1);assert.equal(f.rows.size,1);
  assert.deepEqual(await f.service.createScope(subject,{idempotencyKey:key}),results[0]);
  assert.notEqual((await f.service.createScope(subject,{idempotencyKey:`${key}_new`})).scope_id,results[0].scope_id);
});
test('invalid identities fail before RPC/quote reads; user_metadata is never authority',async()=>{
  for(const change of [{id:other,user_metadata:{role:'admin'}},{id:''},{id:'00000000-0000-0000-0000-000000000000'},{is_anonymous:true},{is_anonymous:undefined},
    {email_confirmed_at:null},{email_confirmed_at:'not-a-date'},{email_confirmed_at:'2027-01-01T00:00:00Z'},
    {deleted_at:'2026-10-10T00:00:00Z'},{deleted_at:''},{banned_until:'2027-01-01T00:00:00Z'},{banned_until:'invalid'}]){
    const f=fixture();Object.assign(f.user,change);if(change.id===other)f.active.delete(other);
    await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));
    assert.equal(f.rows.size,0);assert.equal(f.calls.filter(c=>c[0]==='rpc').length,0);
  }
  const f=fixture();f.authError=true;
  await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));
});
test('caller role/actor/admin/public/GHL/client claims and bad keys rejected, not downgraded',async()=>{
  for(const field of ['user','access_role','user_metadata','audience','client_id','billing_owner_user_id','ghl_import_id']){
    const f=fixture();await assert.rejects(f.service.createScope({...subject,[field]:'forged'},{idempotencyKey:key}),code('sales_scope_denied'));
    await assert.rejects(f.service.createScope(subject,{idempotencyKey:key,[field]:'forged'}),code('invalid_sales_scope_request',400));
    assert.equal(f.rows.size,0);
  }
  for(const bad of ['',null,['forged'],'short','a'.repeat(129),'key with spaces 123456']){
    const f=fixture();await assert.rejects(f.service.createScope(subject,{idempotencyKey:bad}),code('invalid_sales_scope_request',400));
  }
});
test('active rep DB grant required independently of verified identity',async()=>{
  const f=fixture();f.active.delete(rep);
  await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));
  f.grantError=true;await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_access_unavailable',503));
  assert.equal(f.rows.size,0);
});
test('cross-rep and absent scopes are uniform denial with actor-constrained queries',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});f.user.id=other;
  for(const scopeId of [scope.scope_id,crypto.randomUUID(),'not-an-id'])
    await assert.rejects(f.service.authorizeScope({...subject,scopeId}),code('sales_scope_denied'));
  const filters=f.calls.filter(c=>c[0]==='read').slice(1);assert.ok(filters.every(c=>c[2].issuer_user_id===other));
  assert.equal([...f.rows.values()][0].issuer_user_id,rep);
});
test('revocation before/after RPC or scoped read cannot return a usable scope',async()=>{
  for(const call of [1,2,3]){
    const f=fixture();f.beforeAuth=n=>{if(n===call)f.active.delete(rep);};
    await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));
    assert.equal(f.rows.size,call===1?0:1);
  }
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});
  f.beforeRead=()=>f.active.delete(rep);
  await assert.rejects(f.service.authorizeScope({...subject,scopeId:scope.scope_id}),code('sales_scope_denied'));
});
test('definite database errors never reconcile; unknown outcome reads once and never issues second RPC',async()=>{
  for(const mode of ['definite','throw-sql']){
    const f=fixture();f.rpcMode=mode;
    await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_create_failed',503));
    assert.equal(f.readCalls,0);assert.equal(f.calls.filter(c=>c[0]==='rpc').length,1);
  }
  const after=fixture();after.rpcMode='after';assert.ok((await after.service.createScope(subject,{idempotencyKey:key})).scope_id);
  assert.equal(after.readCalls,1);assert.equal(after.calls.filter(c=>c[0]==='rpc').length,1);
  const before=fixture();before.rpcMode='before';
  await assert.rejects(before.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_create_unverified',503));
  assert.equal(before.readCalls,1);assert.equal(before.calls.filter(c=>c[0]==='rpc').length,1);
});
test('malformed/mismatching RPC and stored readback fail without guessed success',async()=>{
  for(const value of [[],[{}],[{},{}]]){
    const f=fixture();f.rpcData=value;
    await assert.rejects(f.service.createScope(subject,{idempotencyKey:key}),code(value.length===1?'sales_scope_readback_unverified':'sales_scope_create_unverified',503));
  }
  for(const change of [{source_verified:true},{audience:'admin'},{issuer_user_id:other},{request_fingerprint:'a'.repeat(64)},
    {created_at:'infinity'},{created_at:'2027-01-01T00:00:00Z'}]){
    const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});Object.assign(f.rows.get(scope.scope_id),change);
    await assert.rejects(f.service.authorizeScope({...subject,scopeId:scope.scope_id}),code(change.issuer_user_id?'sales_scope_denied':'sales_scope_readback_unverified'));
  }
});
test('adapter integrated with actual quote service keeps all12 selections unsigned and rep-owned',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key}),authorized={...subject,scopeId:scope.scope_id};
  const quotes=createMembershipQuoteDraftService({db:f.db,authorizeScope:f.service.authorizeScope,now:()=>new Date(now).toISOString()});
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments']){
    const result=await quotes.createQuote(authorized,{planKey,commitmentMonths,paymentOption,offerVersion:OFFER_VERSION});
    assert.equal(result.quote.original_salesperson_user_id,rep);assert.equal(result.signing_enabled,false);
    assert.deepEqual(await quotes.readQuote(authorized,result.quote.quote_id),result);
  }
  const id=[...f.quotes.keys()][0];f.user.id=other;
  await assert.rejects(quotes.readQuote(authorized,id),code('quote_scope_denied'));
  f.user.id=rep;f.active.delete(rep);await assert.rejects(quotes.listOffers(authorized),code('quote_scope_denied'));
});
test('module remains unmounted; no provider, real client or environment imports',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../src/services/membershipSalesQuoteScopes.js'),'utf8');
  assert.doesNotMatch(source,/require\(['"].*(?:supabase|stripe|ghl|email)/);assert.doesNotMatch(source,/process\.env/);
});
test('empty, whitespace and oversized tokens denied before Auth or RPC; provider token errors stay private',async()=>{
  for(const accessToken of ['',null,' ','token with whitespace','a'.repeat(8193)]){
    const f=fixture();await assert.rejects(f.service.createScope({accessToken},{idempotencyKey:key}),code('sales_scope_denied'));
    assert.equal(f.authCalls,0);assert.equal(f.rows.size,0);
  }
  const inherited=fixture();await assert.rejects(inherited.service.createScope(Object.create(subject),{idempotencyKey:key}),code('sales_scope_denied'));
  assert.equal(inherited.authCalls,0);
  const f=fixture();f.auth.getUser=async()=>{throw Error('SECRETTOKENVALUE private Auth error');};
  await assert.rejects(f.service.createScope({accessToken:'SECRETTOKENVALUE'},{idempotencyKey:key}),e=>e.message==='sales_scope_denied' && !JSON.stringify(e).includes('SECRETTOKENVALUE'));
});
test('only named issuer/key 23505 may reconcile; primary-key or unknown constraint errors do not read',async()=>{
  const safe=fixture();safe.rpcMode='key-conflict';await safe.service.createScope(subject,{idempotencyKey:key});
  assert.equal(safe.readCalls,1);assert.equal(safe.calls.filter(c=>c[0]==='rpc').length,1);
  const unsafe=fixture();unsafe.rpcMode='wrong-conflict';
  await assert.rejects(unsafe.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_create_failed',503));assert.equal(unsafe.readCalls,0);
});
test('scope key hash uses separate domain and does not store plaintext key or access token',async()=>{
  const f=fixture();await f.service.createScope(subject,{idempotencyKey:key});const row=[...f.rows.values()][0];
  assert.equal(row.idempotency_key_hash,crypto.createHash('sha256').update(`manual-prospect-idempotency-v1\n${key}`).digest('hex'));
  assert.equal(row.request_fingerprint,crypto.createHash('sha256').update(`manual-prospect-scope-v1\n${rep}\nsales\nmanual_prospect`).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(key));assert.ok(!JSON.stringify(row).includes(subject.accessToken));
});
test('unsupported added stored fields and corrupt lookups cannot become authorized context',async()=>{
  for(const change of [{client_id:other},{ghl_import_id:other},{billing_owner_user_id:other},{scope_kind:'ghl'},
    {idempotency_key_hash:null}]){
    const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});Object.assign(f.rows.get(scope.scope_id),change);
    await assert.rejects(f.service.authorizeScope({...subject,scopeId:scope.scope_id}),code('sales_scope_readback_unverified',503));
  }
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});f.readError=true;
  await assert.rejects(f.service.authorizeScope({...subject,scopeId:scope.scope_id}),code('sales_scope_store_unavailable',503));
});
test('actual quote pre/post rechecks verify Auth repeatedly; final revocation leaves only inert unsigned row',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});f.authCalls=0;
  const q=createMembershipQuoteDraftService({db:f.db,authorizeScope:f.service.authorizeScope,now:()=>new Date(now).toISOString()});
  f.beforeAuth=n=>{if(n===5)f.active.delete(rep);};
  await assert.rejects(q.createQuote({...subject,scopeId:scope.scope_id},{planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION}),code('quote_scope_denied'));
  assert.equal(f.quotes.size,1);const row=[...f.quotes.values()][0];assert.equal(row.issuer_user_id,rep);
  assert.equal(JSON.parse(row.canonical_quote).acceptance_state,'unsigned');assert.ok(f.authCalls>=5);
});
test('own scope plus another rep quote does not reveal quote; repeated quotes are distinct unsigned drafts',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});
  const q=createMembershipQuoteDraftService({db:f.db,authorizeScope:f.service.authorizeScope,now:()=>new Date(now).toISOString()});
  const selection={planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION};
  const a=await q.createQuote({...subject,scopeId:scope.scope_id},selection),b=await q.createQuote({...subject,scopeId:scope.scope_id},selection);
  assert.notEqual(a.quote.quote_id,b.quote.quote_id);assert.notEqual(a.quote_digest,b.quote_digest);
  f.user.id=other;const otherScope=await f.service.createScope(subject,{idempotencyKey:key});
  await assert.rejects(q.readQuote({...subject,scopeId:otherScope.scope_id},a.quote.quote_id),code('quote_not_found',404));
});
test('returned non-SQL transport outcomes reconcile once with fresh post-read authorization',async()=>{
  const f=fixture();f.rpcMode='returned-after';const scope=await f.service.createScope(subject,{idempotencyKey:key});
  assert.ok(scope.scope_id);assert.equal(f.readCalls,1);assert.equal(f.authCalls,3);assert.equal(f.calls.filter(c=>c[0]==='rpc').length,1);
  const missing=fixture();missing.rpcMode='returned-before';
  await assert.rejects(missing.service.createScope(subject,{idempotencyKey:key}),e=>e.code==='sales_scope_create_unverified' && !JSON.stringify(e).includes('SECRETTOKENVALUE'));
  assert.equal(missing.readCalls,1);assert.equal(missing.calls.filter(c=>c[0]==='rpc').length,1);
  const revoked=fixture();revoked.rpcMode='returned-after';revoked.beforeAuth=n=>{if(n===3)revoked.active.delete(rep);};
  await assert.rejects(revoked.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));
  assert.equal(revoked.readCalls,1);assert.equal(revoked.rows.size,1);
});
test('last readQuote Auth/grant check denies revocation without mutating the stored draft',async()=>{
  const f=fixture(),scope=await f.service.createScope(subject,{idempotencyKey:key});
  const q=createMembershipQuoteDraftService({db:f.db,authorizeScope:f.service.authorizeScope,now:()=>new Date(now).toISOString()});
  const draft=await q.createQuote({...subject,scopeId:scope.scope_id},{planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION});
  const before=structuredClone(f.quotes.get(draft.quote.quote_id));f.authCalls=0;
  f.beforeAuth=n=>{if(n===4)f.active.delete(rep);};
  await assert.rejects(q.readQuote({...subject,scopeId:scope.scope_id},draft.quote.quote_id),code('quote_scope_denied'));
  assert.equal(f.authCalls,4);assert.deepEqual(f.quotes.get(draft.quote.quote_id),before);
  assert.equal(before.issuer_user_id,rep);assert.equal(before.scope_id,scope.scope_id);
  assert.equal(JSON.parse(before.canonical_quote).acceptance_state,'unsigned');
});
test('admin metadata on an active rep cannot change attribution, and without a rep grant cannot create',async()=>{
  const f=fixture();f.user.user_metadata={role:'admin',original_salesperson_user_id:other};
  const scope=await f.service.createScope(subject,{idempotencyKey:key});assert.equal(scope.original_salesperson_user_id,rep);
  assert.ok(!f.calls.some(c=>c[0]==='table' && c[1]==='admins'));
  const absent=fixture();absent.user.user_metadata={role:'admin'};absent.active.delete(rep);
  await assert.rejects(absent.service.createScope(subject,{idempotencyKey:key}),code('sales_scope_denied'));assert.equal(absent.rows.size,0);
  assert.ok(!absent.calls.some(c=>c[0]==='table' && c[1]==='admins'));
});
