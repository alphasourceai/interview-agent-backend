'use strict';
// Native disposablePG only. All keys/recipients/data synthetic; no real provider.
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const h=require('./fixtures/retail-signing-pg'),{canonical,sha}=require('./fixtures/retail-review-fixture');
const {createMembershipCapabilityEnvelope:create}=require('../src/services/membershipCapabilityEnvelope');
const {createMembershipDeliveryWorker}=require('../src/services/membershipDeliveryWorker');
const migration='20261012011336_membership_v2_capability_delivery.sql';
before(()=>{if(process.env.MEMBERSHIP_V2_DISPOSABLE==='true')h.sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations',migration),'utf8'));});
function key(limit=1000000){const bytes=crypto.randomBytes(32),id='synthetic-'+crypto.randomUUID(),fp=sha(bytes);
  h.sql(`set role service_role;insert into membership_v2_delivery_keys(environment,key_id,physical_key_fingerprint,seal_limit) values('dev','${id}','${fp}',${limit});`);
  return {id,fp,service:create({environment:'dev',activeKeyId:id,keys:{[id]:bytes}})};}
function contact(k=key(),queue=true){const f=h.source(),token=crypto.randomBytes(32).toString('base64url'),job=crypto.randomUUID();
  const p={id:f.sourceId,actor:f.actor,scope:f.scopeId,quote:f.quote.quote_id,quote_digest:f.source.quote_digest,previous:f.source.previous_source_id,
    buyer:f.source.buyer,canonical:canonical(f.source),fingerprint:f.sourceFingerprint,token_hash:sha(`sales-email-link-v1\n${f.sourceId}\n${token}`)};
  const b={purpose:'sales_email_link_v1',environment:'dev',source_id:f.sourceId,source_fingerprint:f.sourceFingerprint,buyer_email:f.source.buyer.buyer_email,token_hash:p.token_hash};
  const envelope=k.service.seal({binding:b,token});
  const stmt=`select row_to_json(t) from membership_v2_register_source_and_delivery(${h.literal(p)},'${job}',${h.literal(envelope)}) t;`;
  if(queue)h.sql(`set role service_role;${stmt}`);return {f,p,job,envelope,k,stmt,token};}
function signing(k=key(),queue=true){const f=h.setup(),token=crypto.randomBytes(32).toString('base64url'),job=crypto.randomUUID();
  f.p.signer_token_hash=sha(`retail-signing-v2\n${f.p.id}\n${f.sourceFingerprint}\n${token}`);
  const b={purpose:'retail_signer_v2',environment:'dev',document_id:f.p.id,source_fingerprint:f.sourceFingerprint,buyer_email:f.source.buyer.buyer_email,
    legal_version:f.p.legal_version,html_sha256:f.p.html_sha256,preview_pdf_sha256:f.p.preview_pdf_sha256,token_hash:f.p.signer_token_hash};
  const envelope=k.service.seal({binding:b,token}),stmt=`select row_to_json(t) from membership_v2_issue_document_and_delivery(${h.literal(f.p)},'${job}',${h.literal(envelope)}) t;`;
  if(queue)h.sql(`set role service_role;${stmt}`);return {f,job,envelope,k,stmt,token};}
const count=(table,col,id)=>h.sql(`select count(*) from ${table} where ${col}='${id}';`);
const claim=(x,id=crypto.randomUUID())=>{const text=h.sql(`set role service_role;select row_to_json(t) from membership_v2_claim_delivery('${x.job}','${id}') t;`);
  return text?JSON.parse(text):null;};
function worker(x,hooks={}){const calls=[],sent=[];
  const db={from(table){return {select(fields){const filters=[];const q={eq(k,v){filters.push(`${k}=${h.literal(v)}`);return q;},async maybeSingle(){
    const text=h.sql(`set role service_role;select row_to_json(t) from(select ${fields} from ${table} where ${filters.join(' and ')}) t;`);return {data:text?JSON.parse(text):null,error:null};}};return q;}};},
    async rpc(name,p){calls.push(name);if(hooks.beforeRPC)await hooks.beforeRPC(name,p);
      const order={membership_v2_claim_delivery:['p_job','p_attempt'],membership_v2_before_delivery_send:['p_job','p_attempt'],
        membership_v2_read_delivery_attempt:['p_job','p_attempt'],membership_v2_record_delivery_result:['p_job','p_attempt','p_outcome','p_reference']}[name];assert.ok(order);
      if(name==='membership_v2_claim_delivery' && hooks.claimAbsent)return {error:{code:'NETWORK'}};
      const expr=`${name}(${order.map(k=>h.literal(p[k])).join(',')})`;
      const query=`set role service_role;select ${name==='membership_v2_before_delivery_send'?expr:`coalesce(json_agg(t),'[]') from ${expr} t`};`;
      const raw=h.run(query);if(raw.status)return {error:{code:'P0001',message:'synthetic native denial'}};
      if(hooks.unknown===name){if(hooks.thrown)throw Error('synthetic lost ACK');return {error:{code:'NETWORK'}};}
      const data=name==='membership_v2_before_delivery_send'?raw.stdout.trim()==='t':JSON.parse(raw.stdout);
      if(hooks.afterRPC)await hooks.afterRPC(name,p,data);return {data,error:null};
    }};
  const service=createMembershipDeliveryWorker({db,environment:'dev',origin:'https://interview-agent-frontend-qa.onrender.com',
    allowRecipients:[x.envelope.binding.buyer_email],envelope:x.k.service,send:async p=>{sent.push(p);if(hooks.send)return hooks.send(p);return {status:'accepted',reference:'synthetic-ack'};},...hooks.config});
  return {service,calls,sent};}
test('native worker sends each purpose once with exact recipient/fragment and reports provider ACK not delivery',h.opts,async()=>{
  for(const build of [contact,signing]){const x=build(),w=worker(x),r=await w.service.process({jobId:x.job});
    assert.equal(r.state,'accepted_by_provider');assert.equal(r.recipient_delivery_confirmed,false);assert.equal(r.automatic_retry_allowed,false);
    assert.equal(w.sent.length,1);const url=new URL(w.sent[0].link);assert.equal(url.search,'');assert.equal(url.hash,`#token=${x.token}`);
    assert.equal(w.sent[0].recipient,x.envelope.binding.buyer_email);assert.ok(!JSON.stringify(r).includes(x.token));
    assert.equal((await w.service.process({jobId:x.job})).state,'already_attempted');assert.equal(w.sent.length,1);x.k.service.destroy();}
});
test('committed returned/thrown unknown claim ACK gets one exact readback and one send; absent claim sends nothing',h.opts,async()=>{
  for(const thrown of [false,true]){const x=signing(),w=worker(x,{unknown:'membership_v2_claim_delivery',thrown});
    assert.equal((await w.service.process({jobId:x.job})).state,'accepted_by_provider');assert.equal(w.sent.length,1);
    assert.equal(w.calls.filter(n=>n==='membership_v2_claim_delivery').length,1);assert.equal(w.calls.filter(n=>n==='membership_v2_read_delivery_attempt').length,2);x.k.service.destroy();}
  const x=contact(),w=worker(x,{claimAbsent:true});await assert.rejects(()=>w.service.process({jobId:x.job}),e=>e.code==='membership_delivery_held');
  assert.equal(w.sent.length,0);assert.equal(w.calls.filter(n=>n==='membership_v2_read_delivery_attempt').length,1);x.k.service.destroy();
});
test('provider error or malformed ACK yields one held audit with no automatic second send',h.opts,async()=>{
  for(const send of [()=>{throw Error('SYNTHETIC private provider error');},()=>({status:'accepted',reference:'bad token/reference',delivered:true})]){
    const x=signing(),w=worker(x,{send});assert.equal((await w.service.process({jobId:x.job})).state,'held_unknown');
    assert.equal(w.sent.length,1);assert.equal((await w.service.process({jobId:x.job})).state,'already_attempted');assert.equal(w.sent.length,1);x.k.service.destroy();}
});
test('lost result ACK reads exact committed audit without resending, even if key is retired after actual provider call',h.opts,async()=>{
  const x=signing(),w=worker(x,{unknown:'membership_v2_record_delivery_result',thrown:true,send:()=>{
    h.sql(`set role service_role;update membership_v2_delivery_keys set retired=true where key_id='${x.k.id}';`);return {status:'accepted',reference:'synthetic-ack'};}});
  assert.equal((await w.service.process({jobId:x.job})).state,'accepted_by_provider');assert.equal(w.sent.length,1);
  assert.equal(w.calls.filter(n=>n==='membership_v2_record_delivery_result').length,1);x.k.service.destroy();
});
test('rep deactivation after claim but before final pre-send holds with no callback and no fabricated send result',h.opts,async()=>{
  const x=contact(),w=worker(x,{afterRPC:n=>{if(n==='membership_v2_read_delivery_attempt')h.sql(`update sales_reps set active=false where user_id='${h.rep}';`);}});
  try{assert.equal((await w.service.process({jobId:x.job})).state,'held_unknown');assert.equal(w.sent.length,0);
    assert.equal(count('membership_v2_delivery_results','job_id',x.job),'0');assert.equal(count('membership_v2_delivery_attempts','job_id',x.job),'1');}
  finally{h.sql(`update sales_reps set active=true where user_id='${h.rep}';`);x.k.service.destroy();}
});
test('obsolete proof skips worker and wrong recipient/key/origin fail before claim',h.opts,async()=>{
  const x=contact();h.sql(`set role service_role;select source_id from membership_v2_verify_sales_email('${x.f.sourceId}','${x.p.token_hash}');`);
  const w=worker(x);assert.equal((await w.service.process({jobId:x.job})).state,'skipped_obsolete');assert.equal(w.sent.length,0);
  const y=signing(),raw=JSON.parse(h.sql(`select row_to_json(t) from membership_v2_delivery_jobs t where id='${y.job}';`));assert.equal(raw.sealed_envelope.binding.buyer_email,y.envelope.binding.buyer_email);
  const blockedRecipient=worker(y,{config:{allowRecipients:['different@example.invalid']}});
  await assert.rejects(()=>blockedRecipient.service.process({jobId:y.job}),e=>e.code==='membership_delivery_held');assert.equal(blockedRecipient.sent.length,0);
  const wrongKey=create({environment:'dev',activeKeyId:y.k.id,keys:{[y.k.id]:crypto.randomBytes(32)}}),blockedKey=worker(y,{config:{envelope:wrongKey}});
  await assert.rejects(()=>blockedKey.service.process({jobId:y.job}),e=>e.code==='membership_delivery_held');assert.equal(blockedKey.sent.length,0);wrongKey.destroy();
  assert.throws(()=>worker(y,{config:{origin:'https://example.invalid'}}),e=>e.code==='membership_delivery_not_configured');
  assert.equal(count('membership_v2_delivery_attempts','job_id',y.job),'0');
  assert.throws(()=>createMembershipDeliveryWorker({}),e=>e.code==='membership_delivery_not_configured');x.k.service.destroy();y.k.service.destroy();
});
test('shifted or independently stamped contact challenge cannot gain a native queued envelope',h.opts,()=>{
  for(const shift of ['future_source','wrong_challenge_stamp']){
    const x=contact(undefined,false),p=x.p;
    const sourceTime=shift==='future_source'?"clock_timestamp()+interval '2 minutes'":"clock_timestamp()";
    const challengeTime=shift==='future_source'?'s.created_at':"s.created_at+interval '1 second'";
    const query=`begin;set role service_role;
      insert into membership_v2_sales_prospects(id,scope_id,issuer_user_id,quote_id,quote_digest,previous_source_id,buyer_snapshot,canonical_source,source_fingerprint,created_at)
       values('${p.id}','${p.scope}','${p.actor}','${p.quote}','${p.quote_digest}',null,${h.literal(p.buyer)},${h.literal(p.canonical)},'${p.fingerprint}',${sourceTime});
      insert into membership_v2_sales_email_challenges(source_id,source_fingerprint,token_hash,issued_at,expires_at)
       select id,source_fingerprint,'${p.token_hash}',${challengeTime},${challengeTime}+interval '10 minutes' from membership_v2_sales_prospects s where id='${p.id}';
      insert into membership_v2_sales_prospect_heads(scope_id) values('${p.scope}');
      update membership_v2_sales_prospect_heads set current_source_id='${p.id}' where scope_id='${p.scope}';
      insert into membership_v2_delivery_jobs(id,purpose,source_id,environment,sealed_envelope)
       values('${x.job}','sales_email_link_v1','${p.id}','dev',${h.literal(x.envelope)});commit;`;
    h.denied(query,/delivery_job_denied/);assert.equal(count('membership_v2_sales_prospects','id',p.id),'0');x.k.service.destroy();
  }
});
test('split supplied registry key and envelope key rolls back without burning the alternate budget',h.opts,()=>{
  const x=contact(undefined,false),alternate=key();
  const query=`begin;set role service_role;select id from membership_v2_register_sales_prospect('${x.p.id}','${x.p.actor}','${x.p.scope}','${x.p.quote}',
    '${x.p.quote_digest}',null,${h.literal(x.p.buyer)},${h.literal(x.p.canonical)},'${x.p.fingerprint}','${x.p.token_hash}');
    insert into membership_v2_delivery_jobs(id,purpose,source_id,environment,key_id,nonce,sealed_envelope)
      values('${x.job}','sales_email_link_v1','${x.p.id}','dev','${alternate.id}','${x.envelope.nonce}',${h.literal(x.envelope)});commit;`;
  h.denied(query,/delivery_job_denied/);assert.equal(count('membership_v2_sales_prospects','id',x.p.id),'0');
  for(const k of [x.k,alternate]){assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${k.id}';`),'0');k.service.destroy();}
});
test('both capability kinds atomically persist one native job/header and consume one durable seal slot',h.opts,()=>{
  for(const build of [contact,signing]){const x=build(),row=JSON.parse(h.sql(`set role service_role;select row_to_json(t) from membership_v2_delivery_jobs t where id='${x.job}';`));
    assert.deepEqual(row.sealed_envelope,x.envelope);assert.equal(row.key_id,x.k.id);assert.equal(row.scope_id,x.f.scopeId);
    assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${x.k.id}';`),'1');assert.equal(count('membership_v2_delivery_jobs','id',x.job),'1');x.k.service.destroy();}
});
test('wrong header and budget failure roll back parent creation and count without partial invitation',h.opts,()=>{
  const k=key(1),bad=signing(k,false),e={...bad.envelope,binding:{...bad.envelope.binding,buyer_email:'wrong@example.invalid'}};
  h.denied(`set role service_role;select * from membership_v2_issue_document_and_delivery(${h.literal(bad.f.p)},'${bad.job}',${h.literal(e)});`,/delivery_job_denied/);
  assert.equal(count('membership_v2_issued_documents','id',bad.f.p.id),'0');assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${k.id}';`),'0');
  const first=contact(k),second=contact(k,false);h.denied(`set role service_role;${second.stmt}`,/delivery_key_denied/);
  assert.equal(count('membership_v2_sales_prospects','id',second.f.sourceId),'0');assert.equal(count('membership_v2_sales_email_challenges','source_id',second.f.sourceId),'0');
  assert.equal(count('membership_v2_delivery_jobs','id',second.job),'0');assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${k.id}';`),'1');k.service.destroy();
});
test('committed inert source/document cannot acquire a new envelope through wrapper or direct insert',h.opts,()=>{
  const x=contact(undefined,false);h.sql(`set role service_role;select id from membership_v2_register_sales_prospect('${x.p.id}','${x.p.actor}','${x.p.scope}','${x.p.quote}',
    '${x.p.quote_digest}',null,${h.literal(x.p.buyer)},${h.literal(x.p.canonical)},'${x.p.fingerprint}','${x.p.token_hash}');`);
  h.denied(`set role service_role;${x.stmt}`,/delivery_job_denied/);
  h.denied(`set role service_role;insert into membership_v2_delivery_jobs(id,purpose,source_id,environment,sealed_envelope)
    values('${x.job}','sales_email_link_v1','${x.f.sourceId}','dev',${h.literal(x.envelope)});`,/delivery_job_denied/);
  const y=signing(undefined,false);y.f.issue();h.denied(`set role service_role;${y.stmt}`,/duplicate key/);
  h.denied(`set role service_role;insert into membership_v2_delivery_jobs(id,purpose,source_id,document_id,environment,sealed_envelope)
    values('${y.job}','retail_signer_v2','${y.f.sourceId}','${y.f.p.id}','dev',${h.literal(y.envelope)});`,/delivery_job_denied/);
  assert.equal(count('membership_v2_delivery_jobs','id',x.job),'0');assert.equal(count('membership_v2_delivery_jobs','id',y.job),'0');
  x.k.service.destroy();y.k.service.destroy();
});
test('nonce uniqueness, canonical unused bits and physical-key alias prevent budget/identity bypass',h.opts,()=>{
  const x=contact(),second=contact(x.k,false),e={...second.envelope,nonce:x.envelope.nonce};
  h.denied(`set role service_role;select * from membership_v2_register_source_and_delivery(${h.literal(second.p)},'${second.job}',${h.literal(e)});`,/duplicate key/);
  assert.equal(count('membership_v2_sales_prospects','id',second.f.sourceId),'0');assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${x.k.id}';`),'1');
  const bad={...second.envelope,tag:second.envelope.tag.slice(0,-1)+'B'};
  h.denied(`set role service_role;select * from membership_v2_register_source_and_delivery(${h.literal(second.p)},'${second.job}',${h.literal(bad)});`,/delivery_job_denied/);
  h.denied(`set role service_role;insert into membership_v2_delivery_keys(environment,key_id,physical_key_fingerprint,seal_limit)
    values('production','alias','${x.k.fp}',1000);`,/duplicate key/);x.k.service.destroy();
});
test('eight concurrent native claimers have one winner and exact repeated claim returns no second admission',h.opts,async()=>{
  const x=signing(),ids=Array.from({length:8},()=>crypto.randomUUID());
  const results=await Promise.all(ids.map(id=>h.asyncSQL(`set role service_role;select coalesce(json_agg(t),'[]') from membership_v2_claim_delivery('${x.job}','${id}') t;`).done));
  for(const r of results)assert.equal(r.status,0,r.err);const rows=results.flatMap(r=>JSON.parse(r.out));assert.equal(rows.length,1);assert.equal(rows[0].disposition,'send');
  assert.equal(claim(x,rows[0].attempt_id),null);assert.equal(count('membership_v2_delivery_attempts','job_id',x.job),'1');
  assert.equal(h.sql(`set role service_role;select count(*) from membership_v2_read_delivery_attempt('${x.job}','${rows[0].attempt_id}');`),'1');
  assert.equal(h.sql(`set role service_role;select count(*) from membership_v2_read_delivery_attempt('${x.job}','${crypto.randomUUID()}');`),'0');x.k.service.destroy();
});
test('already verified or accepted invitations skip and cannot record a provider send result',h.opts,()=>{
  const a=contact();h.sql(`set role service_role;select source_id from membership_v2_verify_sales_email('${a.f.sourceId}','${a.p.token_hash}');`);
  const b=signing();h.accept(h.acceptance(b.f));
  for(const x of [a,b]){const r=claim(x);assert.equal(r.disposition,'skip_obsolete');
    assert.equal(h.sql(`set role service_role;select membership_v2_before_delivery_send('${x.job}','${r.attempt_id}');`),'f');
    h.denied(`set role service_role;select * from membership_v2_record_delivery_result('${x.job}','${r.attempt_id}','accepted_by_provider','synthetic-ack');`,/delivery_result_denied/);x.k.service.destroy();}
});
test('retired keys, expired challenges and replaced sources cannot claim or pass final pre-send',h.opts,()=>{
  const x=contact(),r=claim(x);h.sql(`set role service_role;update membership_v2_delivery_keys set retired=true where key_id='${x.k.id}';`);
  h.denied(`set role service_role;select membership_v2_before_delivery_send('${x.job}','${r.attempt_id}');`,/delivery_claim_denied/);
  h.denied(`set role service_role;update membership_v2_delivery_keys set retired=false where key_id='${x.k.id}';`,/delivery_key_transition_denied/);
  const y=contact();h.sql(`alter table membership_v2_sales_email_challenges disable trigger membership_v2_sales_email_challenges_immutable;
    update membership_v2_sales_email_challenges set issued_at=issued_at-interval '2 days',expires_at=expires_at-interval '2 days' where source_id='${y.f.sourceId}';
    alter table membership_v2_sales_email_challenges enable trigger membership_v2_sales_email_challenges_immutable;`);
  h.denied(`set role service_role;select * from membership_v2_claim_delivery('${y.job}','${crypto.randomUUID()}');`,/delivery_claim_denied/);
  const z=signing(),next=h.source({},z.f.sourceId,z.f.scopeId);h.sql(`set role service_role;${next.register}`);
  h.denied(`set role service_role;select * from membership_v2_claim_delivery('${z.job}','${crypto.randomUUID()}');`,/delivery_claim_denied/);
  for(const v of [x,y,z])v.k.service.destroy();
});
test('provider acceptance is immutable audit, exact replay works, null/contradictory references hold and prevents another send',h.opts,()=>{
  const x=signing(),a=claim(x);const record=ref=>`set role service_role;select row_to_json(t) from membership_v2_record_delivery_result('${x.job}','${a.attempt_id}','accepted_by_provider',${h.literal(ref)}) t;`;
  h.denied(record(null),/check constraint/);assert.equal(count('membership_v2_delivery_results','job_id',x.job),'0');
  const first=JSON.parse(h.sql(record('synthetic-ack'))),again=JSON.parse(h.sql(record('synthetic-ack')));assert.deepEqual(first,again);
  h.denied(record('different-ack'),/delivery_result_conflict/);assert.equal(h.sql(`set role service_role;select membership_v2_before_delivery_send('${x.job}','${a.attempt_id}');`),'f');
  assert.equal(first.outcome,'accepted_by_provider');assert.ok(!JSON.stringify(first).includes('delivered'));x.k.service.destroy();
});
test('new rows are immutable/service-only and do not create Auth/client/contract access',h.opts,()=>{
  for(const table of ['membership_v2_delivery_jobs','membership_v2_delivery_attempts','membership_v2_delivery_results']){
    assert.equal(h.sql(`select relrowsecurity from pg_class where oid='${table}'::regclass;`),'t');
    h.denied(`set role authenticated;select * from ${table};`,/permission denied/);h.denied(`truncate ${table} cascade;`,/immutable/);}
  const x=contact();h.denied(`set role service_role;update membership_v2_delivery_jobs set sealed_envelope=sealed_envelope where id='${x.job}';`,/immutable/);
  h.denied(`set role anon;select * from membership_v2_claim_delivery('${x.job}','${crypto.randomUUID()}');`,/permission denied/);
  assert.equal(h.sql('select count(*) from auth.users;'),'2');assert.equal(h.sql('select count(*) from clients;'),'1');assert.equal(h.sql('select count(*) from membership_v2_contracts;'),'0');x.k.service.destroy();
});
test('creator ACK and actor recovery expose only safe fields, never envelope/token/provider reference',h.opts,()=>{
  const x=contact(undefined,false),ack=JSON.parse(h.sql(`set role service_role;${x.stmt}`));
  assert.deepEqual(Object.keys(ack).sort(),['job_id','source_id','document_id','purpose','environment','queued_at'].sort());
  const read=()=>JSON.parse(h.sql(`set role service_role;select row_to_json(t) from membership_v2_delivery_status('${h.rep}','${x.f.scopeId}','${x.job}') t;`));
  assert.equal(read().state,'queued_unchecked');const a=claim(x);assert.equal(read().state,'held_unknown');
  h.sql(`set role service_role;select * from membership_v2_record_delivery_result('${x.job}','${a.attempt_id}','accepted_by_provider','${'A'.repeat(43)}');`);
  const status=read();assert.equal(status.state,'accepted_by_provider');assert.ok(!JSON.stringify(status).includes('A'.repeat(43)));
  assert.ok(!Object.hasOwn(status,'sealed_envelope'));assert.ok(!Object.hasOwn(status,'provider_reference'));
  h.denied(`set role service_role;select * from membership_v2_delivery_status('${h.other}','${x.f.scopeId}','${x.job}');`,/delivery_status_denied/);x.k.service.destroy();
});
test('waited key-retirement gate reads latest retired row before assigning an attempt',h.opts,async()=>{
  const x=signing();const writer=h.asyncSQL(`/* DELIVERY_KEY_RETIRE */begin;set role service_role;update membership_v2_delivery_keys set retired=true
    where key_id='${x.k.id}';select pg_sleep(0.8);commit;`);await h.sleeping('DELIVERY_KEY_RETIRE');
  const reader=h.asyncSQL(`/* DELIVERY_KEY_WAIT */set role service_role;select * from membership_v2_claim_delivery('${x.job}','${crypto.randomUUID()}');`);
  await h.blocked('DELIVERY_KEY_WAIT');const [w,r]=await Promise.all([writer.done,reader.done]);assert.equal(w.status,0,w.err);assert.notEqual(r.status,0);
  assert.match(r.err,/delivery_claim_denied/);assert.equal(count('membership_v2_delivery_attempts','job_id',x.job),'0');x.k.service.destroy();
});
test('legal revocation between claim and final send produces no callback or result audit',h.opts,async()=>{
  const x=signing(),w=worker(x,{beforeRPC:n=>{if(n==='membership_v2_before_delivery_send')h.sql(`set role service_role;
    insert into membership_v2_legal_revocations(version,reason) values('${x.f.p.legal_version}','Synthetic native test');`);}});
  assert.equal((await w.service.process({jobId:x.job})).state,'held_unknown');assert.equal(w.sent.length,0);
  assert.equal(count('membership_v2_delivery_results','job_id',x.job),'0');x.k.service.destroy();
});
