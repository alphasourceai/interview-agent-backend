'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createClient}=require('@supabase/supabase-js');
const {fixture:financial,h}=require('./fixtures/membership-financial-facts-pg');
const {createMembershipAccountProvision}=require('../src/services/membershipAccountProvision');
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',email='buyer@example.invalid';
const adminKey=`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({iss:'supabase',ref:'abcdefghijklmnopqrst',role:'service_role'})).toString('base64url')}.SYNTHETIC_NOT_A_SIGNATURE`;
const keyHash=crypto.createHash('sha256').update(adminKey).digest('hex');
before(()=>{if(process.env.MEMBERSHIP_V2_DISPOSABLE!=='true')return;
  h.sql(`alter table auth.users add column email text,add column email_confirmed_at timestamptz,add column is_anonymous boolean default false,
    add column deleted_at timestamptz,add column banned_until timestamptz,add column is_sso_user boolean default false,
    add column role text default 'authenticated',add column aud text default 'authenticated',add column created_at timestamptz default clock_timestamp();
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),created_at timestamptz,not_after timestamptz);`);
  for(const f of ['20261012191508_membership_v2_capture_facts.sql','20261012203406_membership_v2_buyer_claims.sql','20261012210747_membership_v2_account_provision.sql'])
    h.sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations',f),'utf8'));
});
const hold=p=>assert.rejects(p,e=>e.code==='membership_account_setup_held'&&e.message===e.code);
async function fixture(t,hooks={}) {
  // Synthetic prior fixtures are kept, not deleted. Move their mutable Auth email
  // so each independent case can start with a genuinely absent test address.
  if(!hooks.keepExisting)h.sql(`update auth.users set email=id::text||'@example.invalid' where email='${email}'`);
  const f=await financial(t);if(!hooks.unpaid)await f.observe();const contextId=crypto.randomUUID(),requests=[],rpcs=[];
  const get=table=>JSON.parse(h.sql(`select coalesce((select row_to_json(t) from ${table} t where operation_id='${f.op.id}'),'null'::json)`));
  if(hooks.existing)h.sql(`insert into auth.users(id,email,email_confirmed_at) values('${hooks.existing}', '${email}',${hooks.confirmed?"clock_timestamp()-interval '1 second'":'null'})`);
  h.sql(`insert into membership_v2_account_contexts(id,checkout_context_id,project_url,environment,admin_key_sha256,provisioning_enabled)
    values('${contextId}','${f.x.contextId}','${projectUrl}','dev','${keyHash}',true)`);
  const sdkUser=id=>JSON.parse(h.sql(`select coalesce((select jsonb_build_object('id',id,'email',email,'email_confirmed_at',case when email_confirmed_at is null then null else to_char(email_confirmed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')end,
    'created_at',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'role',role,'aud',aud,'is_anonymous',is_anonymous,'is_sso_user',is_sso_user,
    'user_metadata',jsonb_build_object('admin',true))from auth.users where id='${id}'),'null'::jsonb)`));
  const keys=['p_operation','p_context','p_project','p_environment','p_key_hash','p_action','p_nonce','p_user'];
  const native=(action,nonce=null,user=null)=>`set role service_role;select membership_v2_account_provision('${f.op.id}','${contextId}','${projectUrl}','dev','${keyHash}','${action}',${h.literal(nonce)},${h.literal(user)});`;
  const env={f,contextId,get,native,sdkUser};
  const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;
    requests.push({path:req.url,method:req.method});
    try{
      assert.equal(req.headers.apikey,adminKey);assert.equal(req.headers.authorization,`Bearer ${adminKey}`);let data;
      if(req.url==='/rest/v1/rpc/membership_v2_account_provision'){
        assert.equal(req.method,'POST');const a=JSON.parse(body);rpcs.push(a.p_action);if(hooks.beforeRPC)await hooks.beforeRPC(a,env);
        const r=h.run(`set role service_role;select membership_v2_account_provision(${keys.map(k=>h.literal(a[k])).join(',')});`);
        if(r.status){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'membership_account_setup_held'}));return;}
        data=JSON.parse(r.stdout.trim());if(hooks.afterRPC)await hooks.afterRPC(a,data,env);
        if(hooks.lostRPC===a.p_action){res.destroy();return;}
      }else if(req.url==='/auth/v1/admin/users'){
        assert.equal(req.method,'POST');const b=JSON.parse(body),op=get('membership_v2_account_operations');
        assert.deepEqual(b,{id:op.request_user_id,email:op.email,email_confirm:false});
        if(hooks.beforeCreate)await hooks.beforeCreate(b,env);
        if(hooks.noCreate){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'SYNTHETIC unavailable'}));return;}
        if(h.sql(`select count(*) from auth.users where email=${h.literal(b.email)}`)!=='0'){
          res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'SYNTHETIC duplicate'}));return;
        }
        h.sql(`insert into auth.users(id,email,email_confirmed_at) values('${b.id}',${h.literal(b.email)},null)`);
        data=sdkUser(b.id);if(hooks.afterCreate)await hooks.afterCreate(b,env);
        if(hooks.lostCreate){res.destroy();return;}
      }else{
        assert.equal(req.method,'GET');assert.equal(body,'');const m=req.url.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);assert.ok(m);
        data=sdkUser(m[1]);if(hooks.onGet)await hooks.onGet(m[1],env);
        if(hooks.response)data=hooks.response(structuredClone(data));
        if(!data){res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'SYNTHETIC missing'}));return;}
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
    }catch(_){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'SYNTHETIC rejected'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const fetchImplementation=(url,init)=>{const u=new URL(url);assert.equal(u.origin,projectUrl);assert.equal(u.search,'');
    if(u.pathname.startsWith('/auth/'))assert.equal(init.redirect,'error');return fetch(`http://127.0.0.1:${server.address().port}${u.pathname}`,init);};
  const db=createClient(projectUrl,adminKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fetchImplementation}});
  const create=overrides=>createMembershipAccountProvision({db,projectUrl,adminKey,environment:'dev',contextId,fetchImplementation,...overrides});
  const service=create(),input={operationId:f.op.id},posts=()=>requests.filter(r=>r.path==='/auth/v1/admin/users'&&r.method==='POST').length;
  return {...env,requests,rpcs,create,service,input,posts};
}
test('actual SDK creates exactly native UUID unconfirmed once; no metadata/password/mail/session/ownership/client effects',h.opts,async t=>{
  const f=await fixture(t),r=await f.service.prepare(f.input),op=f.get('membership_v2_account_operations'),binding=f.get('membership_v2_account_bindings');
  assert.equal(r.state,'new_account_prepared');assert.equal(r.accountOwnershipVerified,false);assert.equal(r.emailSent,false);assert.equal(r.activationEnabled,false);
  assert.equal(binding.user_id,op.request_user_id);assert.equal(binding.proof.confirmed_at,null);assert.equal(f.posts(),1);
  assert.equal(h.sql(`select email_confirmed_at is null from auth.users where id='${binding.user_id}'`),'t');
  assert.equal(h.sql('select count(*) from auth.sessions'),'0');assert.equal(h.sql('select count(*) from membership_v2_contracts'),'0');
  assert.ok(!JSON.stringify(binding).includes(adminKey));assert.ok(!JSON.stringify(binding).includes('user_metadata'));
  assert.deepEqual(await f.service.prepare(f.input),r);assert.equal(f.posts(),1);assert.deepEqual(f.get('membership_v2_account_bindings'),binding);
});
for(const confirmed of [false,true])test(`existing account confirmed:${confirmed} remains unchanged and GET-only`,h.opts,async t=>{
  const uid=crypto.randomUUID(),f=await fixture(t,{existing:uid,confirmed}),before=f.sdkUser(uid);
  const r=await f.service.prepare(f.input);assert.equal(r.state,confirmed?'existing_signin_required':'existing_verification_required');
  assert.equal(f.posts(),0);assert.deepEqual(f.sdkUser(uid),before);assert.equal(f.get('membership_v2_account_dispatches'),null);
  assert.equal(f.get('membership_v2_account_bindings').ownership_verified,false);
});
test('lost create ACK recovers ONLY exact native UUID; lost binding ACK one read, no second POST or bind',h.opts,async t=>{
  for(const hooks of [{lostCreate:true},{lostRPC:'bind'}]){const f=await fixture(t,hooks);assert.equal((await f.service.prepare(f.input)).state,'new_account_prepared');
    assert.equal(f.posts(),1);assert.equal(f.rpcs.filter(a=>a==='bind').length,1);assert.equal(f.get('membership_v2_account_bindings').user_id,f.get('membership_v2_account_operations').request_user_id);}
});
test('unknown native dispatch ACK allows NO Auth POST, permanently reserved slot cannot be retried',h.opts,async t=>{
  const f=await fixture(t,{lostRPC:'dispatch'});await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);assert.ok(f.get('membership_v2_account_dispatches'));
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);assert.equal(f.rpcs.filter(a=>a==='dispatch').length,1);
});
test('marker without created user remains held and never recreates/rekeys/retries',h.opts,async t=>{
  const f=await fixture(t,{noCreate:true});await hold(f.service.prepare(f.input));const op=f.get('membership_v2_account_operations');assert.equal(f.posts(),1);
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),1);assert.deepEqual(f.get('membership_v2_account_operations'),op);assert.equal(f.get('membership_v2_account_bindings'),null);
});
test('duplicate email race cannot adopt another Auth UUID or issue another create',h.opts,async t=>{
  const other=crypto.randomUUID(),f=await fixture(t,{beforeCreate:()=>h.sql(`insert into auth.users(id,email)values('${other}','${email}')`)});
  await hold(f.service.prepare(f.input));const op=f.get('membership_v2_account_operations');assert.equal(f.posts(),1);assert.notEqual(op.request_user_id,other);
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),1);assert.equal(f.get('membership_v2_account_bindings'),null);
});
test('closed gate/unpaid graph/duplicates/banned/anonymous/SSO/deleted/privileged profiles cause zero provider effects',h.opts,async t=>{
  const unpaid=await fixture(t,{unpaid:true});await hold(unpaid.service.prepare(unpaid.input));assert.equal(unpaid.requests.filter(r=>r.path.startsWith('/auth/')).length,0);
  const closed=await fixture(t);h.sql(`update membership_v2_account_contexts set provisioning_enabled=false where id='${closed.contextId}'`);
  await hold(closed.service.prepare(closed.input));assert.equal(closed.requests.filter(r=>r.path.startsWith('/auth/')).length,0);
  for(const change of ["banned_until=clock_timestamp()+interval '1 day'","is_anonymous=true","is_sso_user=true","deleted_at=clock_timestamp()","role='service_role'","aud='other'","created_at=clock_timestamp()+interval '1 day'"]){
    const uid=crypto.randomUUID(),f=await fixture(t,{existing:uid});h.sql(`update auth.users set ${change} where id='${uid}'`);
    await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);assert.equal(f.get('membership_v2_account_operations'),null);
  }
  const f=await fixture(t,{existing:crypto.randomUUID()});h.sql(`insert into auth.users(id,email) values('${crypto.randomUUID()}','${email}')`);
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);
});
test('SDK wrong UUID/email/class/timestamp or native change after GET cannot create binding',h.opts,async t=>{
  for(const change of [u=>({...u,id:crypto.randomUUID()}),u=>({...u,email:'wrong@example.invalid'}),u=>({...u,role:'service_role'}),
    u=>({...u,is_anonymous:true}),u=>({...u,created_at:'tomorrow'})]){const f=await fixture(t,{response:change});await hold(f.service.prepare(f.input));assert.equal(f.posts(),1);assert.equal(f.get('membership_v2_account_bindings'),null);}
  const f=await fixture(t,{onGet:id=>h.sql(`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='${id}'`)});
  await hold(f.service.prepare(f.input));assert.equal(f.get('membership_v2_account_bindings'),null);
});
test('native pre-effect checks changed gate/source target; no Auth create after last acknowledged marker read fails',h.opts,async t=>{
  const f=await fixture(t,{afterRPC:(a,d,{contextId})=>{if(a.p_action==='dispatch')h.sql(`update membership_v2_account_contexts set provisioning_enabled=false where id='${contextId}'`);}});
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);assert.ok(f.get('membership_v2_account_dispatches'));
});
test('matching native binding does not make a confirmed account authenticated; later confirmation still GET-only',h.opts,async t=>{
  const f=await fixture(t);await f.service.prepare(f.input);const b=f.get('membership_v2_account_bindings');
  h.sql(`update auth.users set email_confirmed_at=clock_timestamp() where id='${b.user_id}'`);
  const r=await f.service.prepare(f.input);assert.equal(r.state,'existing_signin_required');assert.equal(r.accountOwnershipVerified,false);assert.equal(f.posts(),1);
  assert.deepEqual(f.get('membership_v2_account_bindings'),b);
});
test('real overlapping dispatch requests: one known winner and immutable marker, no second admission',h.opts,async t=>{
  const f=await fixture(t);h.sql(f.native('reserve'));const nonce=crypto.randomBytes(32).toString('base64url');
  const results=await Promise.all([h.asyncSQL(f.native('dispatch',nonce)).done,h.asyncSQL(f.native('dispatch',crypto.randomBytes(32).toString('base64url'))).done]);
  for(const r of results)assert.equal(r.status,0,r.err);assert.deepEqual(results.map(r=>JSON.parse(r.out).won).sort(),[false,true]);
  assert.ok(f.get('membership_v2_account_dispatches'));assert.equal(f.posts(),0);
});
test('browser/direct service writes and Auth reads denied; owner cannot mutate protected config or evidence',h.opts,async t=>{
  const f=await fixture(t);await f.service.prepare(f.input);
  for(const table of ['membership_v2_account_contexts','membership_v2_account_operations','membership_v2_account_dispatches','membership_v2_account_bindings','membership_v2_account_holds']){
    assert.equal(h.sql(`select relrowsecurity and relforcerowsecurity from pg_class where oid='${table}'::regclass`),'t');
    for(const role of ['anon','authenticated','service_role'])for(const q of [`select * from ${table}`,`delete from ${table}`,`truncate ${table}`])h.denied(`set role ${role};${q}`,/permission denied/);
    h.denied(`truncate ${table} cascade`,/immutable/);
  }
  h.denied(`set role service_role;select * from auth.users`,/permission denied/);
  h.denied(`set role service_role;insert into membership_v2_account_bindings(operation_id,user_id,access_enabled) values('${f.f.op.id}','${f.get('membership_v2_account_bindings').user_id}',true)`,/permission denied/);
  h.denied(`update membership_v2_account_contexts set admin_key_sha256=repeat('0',64) where id='${f.contextId}'`,/immutable_account_context/);
  h.denied(`set role authenticated;select membership_v2_account_provision('${f.f.op.id}','${f.contextId}','${projectUrl}','dev','${keyHash}','read',null,null)`,/permission denied/);
});
test('strict input/config rejects extra keys, proxies, accessors, wrong project/key before effect',h.opts,async t=>{
  const f=await fixture(t);for(const v of [null,{...f.input,email},new Proxy(f.input,{}),{get operationId(){throw Error('must not run');}}, {operationId:{}}])await hold(f.service.prepare(v));
  assert.equal(f.requests.length,0);for(const c of [{projectUrl:'https://zyxwvutsrqponmlkjihgf.supabase.co'},{adminKey:'broken'},{environment:'other'}])assert.throws(()=>f.create(c),/membership_account_setup_held/);
  h.sql(`update membership_v2_account_contexts set provisioning_enabled=false where id='${f.contextId}'`);await hold(f.service.prepare(f.input));assert.equal(f.posts(),0);
});
test('ambiguous creation yields append-only closed-reason audit and no reconciliation/create path',h.opts,async t=>{
  const f=await fixture(t,{noCreate:true});await hold(f.service.prepare(f.input));
  const rows=JSON.parse(h.sql(`select jsonb_agg(to_jsonb(t)) from membership_v2_account_holds t where operation_id='${f.f.op.id}'`));
  assert.equal(rows.length,1);assert.equal(rows[0].reason,'creation_readback_held');assert.equal(rows[0].reconciliation_writes_enabled,false);
  h.denied(`update membership_v2_account_holds set reason='identity_held' where id='${rows[0].id}'`,/immutable/);
  h.denied(f.native('hold','arbitrary raw SDK error'),/membership_account_setup_held/);
  h.denied(f.native('reconcile','new'),/membership_account_setup_held/);
  await hold(f.service.prepare(f.input));assert.equal(f.posts(),1);
  assert.equal(h.sql(`select count(*) from membership_v2_account_holds where operation_id='${f.f.op.id}'`),'2');
});
test('same-email distinct purchases reserve different UUIDs; losing create permanently holds without adopting winner',h.opts,async t=>{
  const a=await fixture(t),b=await fixture(t,{keepExisting:true});h.sql(a.native('reserve'));h.sql(b.native('reserve'));
  const opA=a.get('membership_v2_account_operations'),opB=b.get('membership_v2_account_operations');assert.notEqual(opA.request_user_id,opB.request_user_id);
  assert.equal((await a.service.prepare(a.input)).state,'new_account_prepared');await hold(b.service.prepare(b.input));
  assert.equal(b.posts(),0);assert.equal(b.get('membership_v2_account_bindings'),null);assert.deepEqual(b.get('membership_v2_account_operations'),opB);
  await hold(b.service.prepare(b.input));assert.equal(b.posts(),0);
});
