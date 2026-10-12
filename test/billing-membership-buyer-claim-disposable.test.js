'use strict';
const { test, before } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { fixture: financial, h } = require('./fixtures/membership-financial-facts-pg');
const { createMembershipBuyerClaim } = require('../src/services/membershipBuyerClaim');
const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const publicApiKey = 'sb_publishable_SYNTHETIC_NOT_A_CREDENTIAL';
const migration = '20261012203406_membership_v2_buyer_claims.sql';
before(() => {
  if (process.env.MEMBERSHIP_V2_DISPOSABLE !== 'true') return;
  // Disposable hosted-shape Auth schema only. This does NOT modify real Auth.
  h.sql(`alter table auth.users add column email text, add column email_confirmed_at timestamptz,
    add column is_anonymous boolean default false, add column deleted_at timestamptz, add column banned_until timestamptz;
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),created_at timestamptz not null,not_after timestamptz);`);
  for (const file of ['20261012191508_membership_v2_capture_facts.sql', migration])
    h.sql(fs.readFileSync(path.join(__dirname, '../supabase/migrations', file), 'utf8'));
});
const jwt = p => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.SYNTHETIC_NOT_A_SIGNATURE`;
async function fixture(t, hooks = {}) {
  const f = await financial(t); if (!hooks.unpaid) await f.observe();
  const userId = crypto.randomUUID(), sessionId = crypto.randomUUID(), contextId = crypto.randomUUID();
  const confirmed = new Date(Date.now() - 1000).toISOString().replace('Z','123Z'), email = f.op.request_body.customer_email;
  const payload = { sub: userId, iss: `${projectUrl}/auth/v1`, role: 'authenticated', session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt(payload), actor = { user_id: userId, email, confirmed_at: confirmed, session_id: sessionId, expires_epoch: payload.exp };
  let authUser = { id: userId, email, email_confirmed_at: confirmed, is_anonymous: false };
  h.sql(`insert into auth.users(id,email,email_confirmed_at) values('${userId}',${h.literal(email)},${h.literal(confirmed)});
    insert into auth.sessions values('${sessionId}','${userId}',clock_timestamp()-interval '1 second',null);
    insert into membership_v2_buyer_contexts(id,checkout_context_id,project_url,environment,claim_enabled)
     values('${contextId}','${f.x.contextId}','${projectUrl}','dev',true);`);
  const requests = [], rpcs = [], actorProofs = [];
  const keys = { membership_v2_buyer_context: ['p_operation','p_context'],
    membership_v2_record_buyer_claim: ['p_operation','p_context','p_actor'], membership_v2_read_buyer_claim: ['p_operation','p_context','p_actor'] };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    requests.push({ path: req.url, method: req.method });
    try {
      let data;
      if (req.url === '/auth/v1/user') {
        assert.equal(req.method, 'GET'); assert.equal(body, ''); assert.equal(req.headers.apikey, publicApiKey);
        // Synthetic server accepts only fixture-issued exact token, never JWT decode as authentication.
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        if (hooks.onAuth) await hooks.onAuth(requests.filter(r => r.path === '/auth/v1/user').length, { f, userId, sessionId });
        data = authUser;
      } else {
        assert.equal(req.method, 'POST'); const name = req.url.replace('/rest/v1/rpc/', ''); assert.ok(keys[name]);
        const args = JSON.parse(body); rpcs.push(name); if (args.p_actor) actorProofs.push(args.p_actor);
        if (hooks.beforeRPC) await hooks.beforeRPC(name, { f, userId, sessionId, contextId });
        const r = h.run(`set role service_role;select public.${name}(${keys[name].map(k => h.literal(args[k])).join(',')});`);
        if (r.status) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({message:'membership_buyer_claim_held'})); return; }
        data = JSON.parse(r.stdout.trim());
        if (hooks.afterRPC) await hooks.afterRPC(name, { f, userId, sessionId, contextId });
        if (hooks.lostAck && name === 'membership_v2_record_buyer_claim') { res.destroy(); return; }
      }
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data));
    } catch (_) { res.writeHead(401, {'Content-Type':'application/json'}); res.end(JSON.stringify({message:'SYNTHETIC unavailable'})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const fetchImplementation = (url, init) => {
    assert.equal(new URL(url).origin, projectUrl); assert.equal(init.redirect, new URL(url).pathname === '/auth/v1/user' ? 'error' : undefined);
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  };
  const db = createClient(projectUrl, jwt({role:'service_role'}), {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fetchImplementation}});
  const create = overrides => createMembershipBuyerClaim({ db, projectUrl, publicApiKey, environment:'dev',contextId,fetchImplementation,...overrides });
  const service = create(), input = {operationId:f.op.id,accessToken:token};
  const get = () => JSON.parse(h.sql(`select coalesce((select row_to_json(t) from membership_v2_buyer_claims t where operation_id='${f.op.id}'),'null'::json)`));
  const native = (write = true, proof = actor) => `set role service_role;select membership_v2_${write?'record':'read'}_buyer_claim('${f.op.id}','${contextId}',${h.literal(proof)});`;
  return { f, userId, sessionId, contextId, token, actor, payload, input, service, requests, rpcs, actorProofs, create, get, native,
    changeUser: changes => { authUser = {...authUser,...changes}; } };
}
const hold = p => assert.rejects(p, e => e.message === 'membership_buyer_claim_held' && e.code === e.message);
test('actual Auth and PostgREST SDKs/native paid graph claim once; preserve paid anchor; no downstream effects', h.opts, async t => {
  const f = await fixture(t), r = await f.service.claim(f.input), stored = f.get();
  assert.equal(r.accountOwnershipVerified,true); assert.equal(r.activationEnabled,false); assert.equal(r.commissionEnabled,false);
  assert.equal(r.paidAt,f.f.graph.invoice.status_transitions.paid_at); assert.equal(stored.user_id,f.userId);
  assert.deepEqual(await f.service.claim(f.input),r); assert.deepEqual(f.get(),stored);
  assert.equal(f.requests.filter(r => r.path === '/auth/v1/user').length,4);
  assert.ok(f.actorProofs.every(p => !JSON.stringify(p).includes(f.token)));
  assert.ok(!JSON.stringify(stored).includes(f.token));
  assert.equal(h.sql('select count(*) from membership_v2_contracts'),'0');
});
test('lost commit ACK: fresh Auth + one authorized read, zero repeat insert', h.opts, async t => {
  const f = await fixture(t,{lostAck:true}); assert.equal((await f.service.claim(f.input)).accountOwnershipVerified,true);
  assert.equal(f.rpcs.filter(n=>n==='membership_v2_record_buyer_claim').length,1);
  assert.equal(f.rpcs.filter(n=>n==='membership_v2_read_buyer_claim').length,1);
  assert.equal(f.requests.filter(r=>r.path==='/auth/v1/user').length,2);
});
test('wrong/missing native payment or config closed prevents claim', h.opts, async t => {
  const unpaid = await fixture(t,{unpaid:true}); await hold(unpaid.service.claim(unpaid.input)); assert.equal(unpaid.get(),null);
  const f = await fixture(t); h.sql(`update membership_v2_buyer_contexts set claim_enabled=false where id='${f.contextId}'`);
  await hold(f.service.claim(f.input)); assert.equal(f.requests.length,1); assert.equal(f.get(),null);
});
test('verified source email stays exact; plus/dot aliases are not collapsed; metadata cannot authorize', h.opts, async t => {
  const f=await fixture(t); f.changeUser({email:'different@example.invalid',user_metadata:{email:f.actor.email}});
  await hold(f.service.claim(f.input)); assert.equal(f.get(),null);
  f.changeUser({email:`\t ${f.actor.email.toUpperCase()} \n`}); assert.equal((await f.service.claim(f.input)).accountOwnershipVerified,true);
  h.denied(f.native(false,{...f.actor,email:f.actor.email.replace('@','+other@')}),/membership_buyer_claim_held/);
});
test('native current ban, deletion, anonymous/unconfirmed/future confirmation and session expiry reject', h.opts, async t => {
  const changes=[`banned_until=clock_timestamp()+interval '1 day'`,`deleted_at=clock_timestamp()`,`is_anonymous=true`,
    `email_confirmed_at=null`,`email_confirmed_at=clock_timestamp()+interval '1 day'`,`email='other@example.invalid'`];
  for(const change of changes){const f=await fixture(t);h.sql(`update auth.users set ${change} where id='${f.userId}'`);
    await hold(f.service.claim(f.input));assert.equal(f.get(),null);}
  for(const change of [`not_after=clock_timestamp()-interval '1 second'`,`created_at=clock_timestamp()+interval '1 day'`]){
    const f=await fixture(t);h.sql(`update auth.sessions set ${change} where id='${f.sessionId}'`);await hold(f.service.claim(f.input));assert.equal(f.get(),null);}
});
test('logout between verified getUser and native insert, or after insert before ACK-read, holds without retry', h.opts, async t => {
  for(const after of [false,true]){
    const hooks=after?{afterRPC:(name,{sessionId})=>{if(name==='membership_v2_record_buyer_claim')h.sql(`delete from auth.sessions where id='${sessionId}'`);}}
      :{onAuth:(count,{sessionId})=>{if(count===1)h.sql(`delete from auth.sessions where id='${sessionId}'`);}};
    const f=await fixture(t,hooks);await hold(f.service.claim(f.input));assert.equal(!!f.get(),after);
    assert.equal(f.rpcs.filter(n=>n==='membership_v2_record_buyer_claim').length,1);
  }
});
test('successful/lost-ACK read revalidates current SDK actor, with no leaked winner', h.opts, async t => {
  const f=await fixture(t,{afterRPC:(name,{userId})=>{if(name==='membership_v2_record_buyer_claim')h.sql(`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='${userId}'`);}});
  await hold(f.service.claim(f.input));assert.ok(f.get());
  const g=await fixture(t);await g.service.claim(g.input);g.changeUser({is_anonymous:true});await hold(g.service.claim(g.input));
  assert.equal(g.rpcs.filter(n=>n==='membership_v2_read_buyer_claim').length,1);
});
test('first buyer immutable: a second confirmed Auth UUID with same email cannot replace or read winner', h.opts, async t => {
  const f=await fixture(t);await f.service.claim(f.input);const stored=f.get(),other=crypto.randomUUID(),sid=crypto.randomUUID();
  h.sql(`insert into auth.users(id,email,email_confirmed_at) values('${other}',${h.literal(f.actor.email)},${h.literal(f.actor.confirmed_at)});
    insert into auth.sessions values('${sid}','${other}',clock_timestamp()-interval '1 second',null);`);
  for(const write of [true,false])h.denied(f.native(write,{...f.actor,user_id:other,session_id:sid}),/membership_buyer_claim_held/);
  assert.deepEqual(f.get(),stored);
});
test('real concurrent native inserts share one purchase mutex and immutable winner', h.opts, async t => {
  const f=await fixture(t);const results=await Promise.all([h.asyncSQL(f.native()).done,h.asyncSQL(f.native()).done]);
  for(const r of results)assert.equal(r.status,0,r.err);assert.equal(results[0].out,results[1].out);
  assert.equal(h.sql(`select count(*) from membership_v2_buyer_claims where operation_id='${f.f.op.id}'`),'1');
});
test('native samples expiry after operation-lock wait, not transaction start', h.opts, async t => {
  const f=await fixture(t),expiry=Math.floor(Date.now()/1000)+2;
  const lock=h.asyncSQL(`begin;select id from membership_v2_checkout_operations where id='${f.f.op.id}' for update;
    select pg_sleep(3);commit; /* buyer_claim_lock */`);await h.sleeping('buyer_claim_lock');
  const claim=h.asyncSQL(`${f.native(true,{...f.actor,expires_epoch:expiry})} /* buyer_claim_wait */`);
  await h.blocked('buyer_claim_wait');assert.equal((await lock.done).status,0);
  const result=await claim.done;assert.notEqual(result.status,0);assert.match(result.err,/membership_buyer_claim_held/);assert.equal(f.get(),null);
});
test('real Auth mutation races: native user/session locks observe a committed ban or logout before claiming', h.opts, async t => {
  for(const kind of ['ban','logout']){
    const f=await fixture(t),tag=`buyer_${kind}_lock`,wait=`buyer_${kind}_wait`;
    const mutation=kind==='ban'?`update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='${f.userId}'`
      :`delete from auth.sessions where id='${f.sessionId}'`;
    const locked=h.asyncSQL(`begin;${mutation};select pg_sleep(1);commit; /* ${tag} */`);await h.sleeping(tag);
    const claim=h.asyncSQL(`${f.native()} /* ${wait} */`);await h.blocked(wait);
    assert.equal((await locked.done).status,0);const r=await claim.done;assert.notEqual(r.status,0);assert.match(r.err,/membership_buyer_claim_held/);
    assert.equal(f.get(),null);
  }
});
test('Auth outage/invalid SDK identity/expired token are opaque holds; native field mismatch remains denied', h.opts, async t => {
  const f=await fixture(t,{onAuth:()=>{throw Error('SYNTHETIC outage');}});await hold(f.service.claim(f.input));assert.equal(f.get(),null);
  const g=await fixture(t);
  for(const change of [{id:crypto.randomUUID()},{email_confirmed_at:null},{is_anonymous:true}]){
    g.changeUser(change);await hold(g.service.claim(g.input));assert.equal(g.get(),null);
    g.changeUser({id:g.userId,email_confirmed_at:g.actor.confirmed_at,is_anonymous:false});
  }
  await hold(g.service.claim({...g.input,accessToken:jwt({...g.payload,exp:946684800})}));assert.equal(g.get(),null);
  for(const change of [{expires_epoch:946684800},{confirmed_at:'tomorrow'},{session_id:crypto.randomUUID()}])
    h.denied(g.native(true,{...g.actor,...change}),/membership_buyer_claim_held/);
});
test('ACL/RLS private routines deny browsers, direct runtime writes/reads and derived-field bypass', h.opts, async t => {
  const f=await fixture(t);await f.service.claim(f.input);const stored=f.get();
  for(const table of ['membership_v2_buyer_claims','membership_v2_buyer_contexts']){
    assert.equal(h.sql(`select relrowsecurity and relforcerowsecurity from pg_class where oid='${table}'::regclass`),'t');
    for(const role of ['anon','authenticated'])for(const q of [`select * from ${table}`,`delete from ${table}`,`truncate ${table}`])h.denied(`set role ${role};${q}`,/permission denied/);
    for(const q of [`update ${table} set ${table.endsWith('contexts')?'claim_enabled=true':'access_eligible=true'}`,`delete from ${table}`,`truncate ${table}`])h.denied(`set role service_role;${q}`,/permission denied/);
    h.denied(`truncate ${table} cascade`,/immutable/);
  }
  h.denied('set role service_role;select * from membership_v2_buyer_claims',/permission denied/);
  h.denied(`set role service_role;insert into membership_v2_buyer_claims(operation_id,user_id,access_eligible)values('${f.f.op.id}','${f.userId}',true)`,/permission denied/);
  h.denied(`set role authenticated;select membership_v2_record_buyer_claim('${f.f.op.id}','${f.contextId}',${h.literal(f.actor)})`,/permission denied/);
  h.denied(`set role service_role;select * from auth.users`,/permission denied/);
  h.denied(`set role service_role;select * from auth.sessions`,/permission denied/);
  h.denied(`update membership_v2_buyer_contexts set project_url='https://zyxwvutsrqponmlkjihg.supabase.co' where id='${f.contextId}'`,/immutable_buyer_context/);
  h.denied(`update membership_v2_buyer_claims set access_eligible=true where operation_id='${f.f.op.id}'`,/immutable/);
  assert.deepEqual(f.get(),stored);
});
test('malformed/accessor/proxy/request-selected identities and project/key mismatch have no network effects', h.opts, async t => {
  const f=await fixture(t);
  for(const v of [null,{...f.input,userId:f.userId},{...f.input,accessToken:{}},new Proxy(f.input,{}),
    {operationId:f.f.op.id,get accessToken(){throw Error('must not run');}},{...f.input,accessToken:'broken'}])await hold(f.service.claim(v));
  assert.equal(f.requests.length,0);
  for(const args of [{publicApiKey:jwt({role:'service_role'})},{environment:'other'},{projectUrl:'https://zyxwvutsrqponmlkjihg.supabase.co'}])assert.throws(()=>f.create(args),/membership_buyer_claim_held/);
  assert.equal(f.requests.length,0);
  for(const p of [{...f.actor,access_token:f.token},{...f.actor,email:null},{...f.actor,expires_epoch:0},{...f.actor,user_id:'bad'}])h.denied(f.native(true,p),/membership_buyer_claim_held/);
  assert.equal(f.get(),null);
});
test('original payment stays historical despite later refund/dispute; ownership gives NO funded access', h.opts, async t => {
  const f=await fixture(t);f.f.graph.charge.amount_refunded=f.f.graph.charge.amount;f.f.graph.charge.disputed=true;await f.f.observe();
  const r=await f.service.claim(f.input);assert.equal(r.accountOwnershipVerified,true);assert.equal(r.activationEnabled,false);
  assert.equal(r.paidAt,f.f.graph.invoice.status_transitions.paid_at);
  for(const k of ['access','term','commission','collection'])assert.equal(f.get()[`${k}_eligible`],false);
});
