'use strict';
// Actual local PG parent + issuer/PNG signing + pending linkage; fake files/PDF
// renderer only. No hosted Auth/storage/Stripe/mail or paid acceptance claim.
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const h=require('./fixtures/retail-signing-pg'),{sha}=require('./fixtures/retail-review-fixture'),{signature}=require('./fixtures/retail-signature');
const {createMembershipRetailSigningService}=require('../src/services/membershipRetailSigning');
const {createMembershipPendingPurchase}=require('../src/services/membershipPendingPurchase');
const enabled=process.env.MEMBERSHIP_V2_DISPOSABLE==='true',PDF=Buffer.from('%PDF-1.7\nSYNTHETIC PENDING PURCHASE\n%%EOF');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261012155804_membership_v2_pending_purchases.sql'),'utf8');
before(()=>{if(enabled)h.sql(migration);});
function setup(selection={},hooks={}){
 const f=h.setup(selection),token='T'.repeat(43),files=new Map(),calls=[];
 f.p.preview_pdf_sha256=sha(PDF);f.p.preview_pdf_size=PDF.length;f.p.signer_token_hash=sha(`retail-signing-v2\n${f.p.id}\n${f.sourceFingerprint}\n${token}`);
 f.issue();files.set(f.p.preview_pdf_path,Buffer.from(PDF));
 const db={from(table){return {select(columns){const filters=[];return {eq(k,v){filters.push(`${k}=${h.literal(v)}`);return this;},async maybeSingle(){
  const r=h.run(`set role service_role;select row_to_json(t) from (select ${columns} from ${table} where ${filters.join(' and ')}) t;`);
  return r.status?{error:{code:'SQLERR'}}:{data:r.stdout.trim()?JSON.parse(r.stdout):null,error:null};}};}};},
 async rpc(name,p){calls.push(name);if(hooks.beforeRPC)await hooks.beforeRPC(name,p);
  const keys={membership_v2_signing_session:['p_document','p_token_hash'],membership_v2_read_acceptance_attempt:['p_document','p_token_hash','p_attempt'],
   membership_v2_accept_png_document:['p_acceptance','p_pixels_hash','p_width','p_height'],membership_v2_pending_source:['p_document','p_token_hash','p_current'],
   membership_v2_reserve_pending_purchase:['p_id','p_document','p_token_hash','p_environment'],membership_v2_read_pending_purchase:['p_document','p_token_hash','p_environment']}[name];
  assert.ok(keys);const isList=/signing_session|read_acceptance_attempt|accept_png_document/.test(name);
  const query=`set role service_role;select ${isList?'coalesce(json_agg(t),\'[]\'::json) from ':''}${name}(${keys.map(k=>h.literal(p[k])).join(',')})${isList?' t':''};`;
  const r=hooks.concurrent && name==='membership_v2_reserve_pending_purchase'?await h.asyncSQL(query).done:h.run(query);
  const output=r.out||r.stdout,error=r.err||r.stderr;
  if(r.status){const match=error.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);return {error:{code:match?.[1]||'SQLERR',message:match?.[2]||'SYNTHETIC SQL error'}};}
  if(hooks.unknown && name==='membership_v2_reserve_pending_purchase'){if(hooks.unknown==='throw')throw Error('SYNTHETIC lost reply');return {error:{code:'NETWORK'}};}
  return {data:output.trim()?JSON.parse(output):null,error:null};
 }};
 const signing=createMembershipRetailSigningService({db,artifacts:{async readPrivate(p){return files.get(p);},async putIfAbsent(p,b,o){
  assert.equal(o.upsert,false);assert.ok(!files.has(p));files.set(p,Buffer.from(b));}},renderExecution:async()=>({pdf_bytes:PDF})});
 const input={documentId:f.p.id,token},service=createMembershipPendingPurchase({db,signing,environment:'dev'});
 return {f,files,calls,db,signing,service,input,sign:()=>signing.sign({...input,typedName:'Demo Buyer',consent:true,signatureDataUrl:signature()})};
}
const reserve=(x,env='dev',id=crypto.randomUUID())=>`select membership_v2_reserve_pending_purchase('${id}','${x.f.p.id}','${x.f.p.signer_token_hash}','${env}');`;
const read=x=>JSON.parse(h.sql(`set role service_role;select membership_v2_read_pending_purchase('${x.f.p.id}','${x.f.p.signer_token_hash}','dev');`));
function invariants(){return h.sql(`select jsonb_build_object('legacyclients',(select jsonb_agg(to_jsonb(c)) from clients c),
 'legacyagreements',(select jsonb_agg(to_jsonb(a)) from membership_agreements a),'legacyintents',(select jsonb_agg(to_jsonb(i)) from public_purchase_intents i),
 'contracts',(select count(*) from membership_v2_contracts),'users',(select count(*) from auth.users),
 'parentdefs',(select jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
 from pg_class where oid in('membership_v2_contracts'::regclass,'clients'::regclass,'auth.users'::regclass)));`);}
function simulatePastClockHistory(x){
 // Privileged synthetic fixture only, not a product writer/backfill permission.
 // Shift the accepted clock descriptors/proof and any pending record together
 // to reach deadline behavior without waiting a day. No identity/money change.
 const f=x.f;
 h.sql(`begin;
  alter table membership_v2_issued_documents disable trigger membership_v2_issued_documents_immutable;
  alter table membership_v2_document_acceptances disable trigger membership_v2_document_acceptances_immutable;
  alter table membership_v2_signature_pixels disable trigger membership_v2_signature_pixels_immutable;
  alter table membership_v2_legal_versions disable trigger membership_v2_legal_versions_immutable;
  alter table membership_v2_sales_email_challenges disable trigger membership_v2_sales_email_challenges_immutable;
  alter table membership_v2_sales_email_proofs disable trigger membership_v2_sales_email_proofs_immutable;
  alter table membership_v2_pending_purchases disable trigger membership_v2_pending_purchases_immutable;
  update membership_v2_legal_versions set approved_at=approved_at-interval '2 days' where version='${f.p.legal_version}';
  update membership_v2_issued_documents set issued_at=issued_at-interval '2 days',expires_at=membership_v2_signing_deadline(issued_at-interval '2 days'),
   legal_snapshot=jsonb_set(legal_snapshot,'{approved_at}',(select to_jsonb(approved_at) from membership_v2_legal_versions where version='${f.p.legal_version}')) where id='${f.p.id}';
  update membership_v2_document_acceptances set accepted_at=accepted_at-interval '2 days' where document_id='${f.p.id}';
  update membership_v2_signature_pixels set recorded_at=recorded_at-interval '2 days' where document_id='${f.p.id}';
  update membership_v2_sales_email_challenges set issued_at=issued_at-interval '2 days',expires_at=expires_at-interval '2 days' where source_id='${f.sourceId}';
  update membership_v2_sales_email_proofs set verified_at=verified_at-interval '2 days' where source_id='${f.sourceId}';
  update membership_v2_pending_purchases set source_snapshot=(membership_v2_pending_source('${f.p.id}','${f.p.signer_token_hash}',false)->'snapshot'),
   source_digest=(membership_v2_pending_source('${f.p.id}','${f.p.signer_token_hash}',false)->>'digest'),created_at=created_at-interval '2 days',
   expires_at=(select expires_at from membership_v2_issued_documents where id='${f.p.id}') where document_id='${f.p.id}';
  alter table membership_v2_issued_documents enable trigger membership_v2_issued_documents_immutable;
  alter table membership_v2_document_acceptances enable trigger membership_v2_document_acceptances_immutable;
  alter table membership_v2_signature_pixels enable trigger membership_v2_signature_pixels_immutable;
  alter table membership_v2_legal_versions enable trigger membership_v2_legal_versions_immutable;
  alter table membership_v2_sales_email_challenges enable trigger membership_v2_sales_email_challenges_immutable;
  alter table membership_v2_sales_email_proofs enable trigger membership_v2_sales_email_proofs_immutable;
  alter table membership_v2_pending_purchases enable trigger membership_v2_pending_purchases_immutable;commit;`);
}
for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments'])for(const firstRolePrepay of [false,true]){
 test(`actual native accepted pending linkage ${planKey}/${commitmentMonths}/${paymentOption}/first-role:${firstRolePrepay}`,h.opts,async()=>{
  const before=invariants(),x=setup({planKey,commitmentMonths,paymentOption,firstRolePrepaySelected:firstRolePrepay});await x.sign();const result=await x.service.reserve(x.input),r=read(x);
  assert.equal(result.disposition,'recorded_pending_linkage');assert.equal(result.account_ownership_verified,false);assert.equal(result.provider_effects_enabled,false);
  assert.equal(r.purchase.source_snapshot.quote.offer.plan_key,planKey);assert.equal(r.purchase.source_snapshot.quote.offer.commitment_months,commitmentMonths);
  assert.equal(r.purchase.source_snapshot.quote.offer.payment_option,paymentOption);assert.equal(r.purchase.original_salesperson_user_id,h.rep);
  assert.equal(r.purchase.source_snapshot.quote.offer.first_role_prepay.selected,firstRolePrepay);
  assert.equal(r.purchase.source_snapshot.quote.offer.first_role_prepay.amount_cents,firstRolePrepay?(planKey==='basic'?35900:62900):0);
  assert.equal(r.purchase.source_snapshot.quote.offer.initial_payment_cents,r.purchase.source_snapshot.quote.offer.platform_payment_cents+
   r.purchase.source_snapshot.quote.offer.first_role_prepay.amount_cents);
  const again=await x.service.reserve(x.input);assert.equal(again.purchase_id,result.purchase_id);assert.equal(again.created_at,result.created_at);
  assert.equal(again.disposition,'historical_inert');assert.equal(read(x).purchase.source_digest,r.purchase.source_digest);assert.equal(invariants(),before);
 });
}
test('unsigned/missing pixels/wrong token produce no pending row and no fabricated contract',h.opts,async()=>{
 const x=setup();await assert.rejects(()=>x.service.reserve(x.input),e=>e.code==='pending_purchase_acceptance_required');h.denied(`set role service_role;${reserve(x)}`,/pending_purchase_source_denied/);
 await x.sign();await assert.rejects(()=>x.service.reserve({...x.input,token:'Z'.repeat(43)}),e=>e.code==='pending_purchase_capability_denied');
 const unproven=setup();h.accept(h.acceptance(unproven.f));h.denied(`set role service_role;${reserve(unproven)}`,/pending_purchase_source_denied/);
 assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id in('${x.f.p.id}','${unproven.f.p.id}')`),'0');
});
test('new legal publication preserves accepted descriptor; substituting it is not permitted',h.opts,async()=>{
 const x=setup();await x.sign();const other=setup();await other.sign();const r=await x.service.reserve(x.input);
 assert.equal(read(x).purchase.source_snapshot.legal.version,x.f.p.legal_version);assert.notEqual(x.f.p.legal_version,other.f.p.legal_version);
 h.denied(`set role service_role;insert into membership_v2_pending_purchases(id,document_id,environment,source_snapshot)
 values('${crypto.randomUUID()}','${other.f.p.id}','dev','{"legal":{"version":"SUBSTITUTED"}}')`,/derived_fields_denied/);assert.ok(r.purchase_id);
});
test('matching existing record remains historical after legal revocation; newly revoked source cannot reserve',h.opts,async()=>{
 const x=setup();await x.sign();const r=await x.service.reserve(x.input);
 h.sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${x.f.p.legal_version}','SYNTHETIC');`);
 assert.equal((await x.service.reserve(x.input)).purchase_id,r.purchase_id);assert.equal((await x.service.reserve(x.input)).disposition,'historical_inert');
 const y=setup();await y.sign();h.sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${y.f.p.legal_version}','SYNTHETIC');`);
 await assert.rejects(()=>y.service.reserve(y.input),e=>e.code==='pending_purchase_commit_failed');
});
test('inactive rep preserves accepted source attribution without granting rep or account access',h.opts,async()=>{
 const x=setup();await x.sign();h.sql(`update sales_reps set active=false where user_id='${h.rep}'`);
 try{const result=await x.service.reserve(x.input);assert.equal(result.account_ownership_verified,false);assert.equal(read(x).purchase.original_salesperson_user_id,h.rep);}
 finally{h.sql(`update sales_reps set active=true where user_id='${h.rep}'`);}
});
test('same-source concurrent reservations serialize and retain one native ID/time with no head mutation',h.opts,async()=>{
 let arrivals=0,release;const barrier=new Promise(r=>release=r),x=setup({}, {concurrent:true,beforeRPC:async name=>{
  if(name==='membership_v2_reserve_pending_purchase'){if(++arrivals===2)release();await barrier;}}});await x.sign();
 const head=h.sql(`select row_to_json(h) from membership_v2_sales_prospect_heads h where scope_id='${x.f.scopeId}'`);
 const [a,b]=await Promise.all([x.service.reserve(x.input),x.service.reserve(x.input)]);assert.equal(a.purchase_id,b.purchase_id);assert.equal(a.created_at,b.created_at);
 assert.deepEqual([a.disposition,b.disposition].sort(),['historical_inert','recorded_pending_linkage']);
 assert.equal(h.sql(`select row_to_json(h) from membership_v2_sales_prospect_heads h where scope_id='${x.f.scopeId}'`),head);
});
test('ambiguous thrown/returned commit recovers only exact native row, no second reserve',h.opts,async()=>{
 for(const unknown of ['throw','returned']){const x=setup({}, {unknown});await x.sign();const r=await x.service.reserve(x.input);
  assert.equal(r.persistence,'recovered_unknown_commit');assert.equal(r.disposition,'historical_inert');assert.equal(x.calls.filter(n=>n==='membership_v2_reserve_pending_purchase').length,1);
  assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id='${x.f.p.id}'`),'1');}
});
test('native descriptor checksum and original identity are independent of session timezone',h.opts,async()=>{
 const x=setup();await x.sign();await x.service.reserve(x.input);
 const a=JSON.parse(h.sql(`set role service_role;set timezone='UTC';select membership_v2_read_pending_purchase('${x.f.p.id}','${x.f.p.signer_token_hash}','dev');`));
 const b=JSON.parse(h.sql(`set role service_role;set timezone='Pacific/Honolulu';select membership_v2_read_pending_purchase('${x.f.p.id}','${x.f.p.signer_token_hash}','dev');`));
 assert.deepEqual(a.purchase.source_snapshot,b.purchase.source_snapshot);assert.equal(a.purchase.source_digest,b.purchase.source_digest);
 assert.equal(a.purchase.id,b.purchase.id);assert.equal(Date.parse(a.purchase.created_at),Date.parse(b.purchase.created_at));
});
test('other environment conflicts without second row, while unrelated accepted sale reserves independently',h.opts,async()=>{
 const x=setup(),y=setup();await x.sign();await y.sign();await x.service.reserve(x.input);await y.service.reserve(y.input);
 h.denied(`set role service_role;${reserve(x,'production')}`,/pending_purchase_conflict/);
 assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id in('${x.f.p.id}','${y.f.p.id}')`),'2');
});
test('native RLS/grants/immutability deny all browser operations, service mutation, and privileged truncate',h.opts,async()=>{
 const x=setup();await x.sign();await x.service.reserve(x.input);
 for(const role of ['anon','authenticated'])for(const q of ['select * from membership_v2_pending_purchases',
  `insert into membership_v2_pending_purchases(id,document_id,environment) values('${crypto.randomUUID()}','${x.f.p.id}','dev')`,
  'update membership_v2_pending_purchases set environment=environment','delete from membership_v2_pending_purchases','truncate membership_v2_pending_purchases'])h.denied(`set role ${role};${q}`,/permission denied/);
 for(const q of ['update membership_v2_pending_purchases set environment=environment','delete from membership_v2_pending_purchases','truncate membership_v2_pending_purchases'])
  h.denied(`set role service_role;${q}`,/permission denied/);
 h.denied('truncate membership_v2_pending_purchases',/immutable/);h.denied('update membership_v2_pending_purchases set activation_enabled=true',/immutable/);
 assert.equal(h.sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='membership_v2_pending_purchases'::regclass"),'t');
});
test('direct native insert must omit derived fields and cannot enable any effect flag',h.opts,async()=>{
 for(const fields of [{state:'active'},{provider_effects_enabled:true},{account_ownership_verified:true},{activation_enabled:true},
  {source_snapshot:{amount:0}},{created_at:'2020-01-01Z'},{original_salesperson_user_id:h.other}]){
  const x=setup();await x.sign();h.denied(`set role service_role;${h.insert('membership_v2_pending_purchases',{id:crypto.randomUUID(),document_id:x.f.p.id,environment:'dev',...fields})}`,
   /derived_fields_denied|inert_required/);assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id='${x.f.p.id}'`),'0');
 }
});
test('native strict deadline rejects new reservation; expired existing identity remains historical without extending time',h.opts,async()=>{
 const x=setup();await x.sign();simulatePastClockHistory(x);
 h.denied(`set role service_role;${reserve(x)}`,/pending_purchase_source_unavailable/);
 assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id='${x.f.p.id}'`),'0');
 const y=setup();await y.sign();const first=await y.service.reserve(y.input);simulatePastClockHistory(y);const before=read(y).purchase;
 const history=await y.service.reserve(y.input);assert.equal(history.purchase_id,first.purchase_id);assert.equal(history.disposition,'historical_inert');
 assert.equal(history.expires_at,before.expires_at);assert.equal(history.created_at,before.created_at);assert.ok(Date.parse(history.expires_at)<Date.now());
 assert.equal(history.provider_effects_enabled,false);assert.equal(history.activation_enabled,false);
});
test('native reservation blocked behind legal revocation rechecks committed gate and writes nothing',h.opts,async()=>{
 const x=setup();await x.sign();
 const writer=h.asyncSQL(`/* PENDING_LEGAL_HELD */begin;set role service_role;insert into membership_v2_legal_revocations(version,reason)
 values('${x.f.p.legal_version}','SYNTHETIC race');select pg_sleep(0.8);commit;`);
 await h.sleeping('PENDING_LEGAL_HELD');const pending=h.asyncSQL(`/* PENDING_LEGAL_WAIT */set role service_role;${reserve(x)}`);
 await h.blocked('PENDING_LEGAL_WAIT');const [w,r]=await Promise.all([writer.done,pending.done]);assert.equal(w.status,0,w.err);
 assert.notEqual(r.status,0);assert.match(r.err,/pending_purchase_source_unavailable/);
 assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id='${x.f.p.id}'`),'0');
});
test('native size CHECK remains a defense even without the derivation trigger; synthetic bypass probe rolls back',h.opts,async()=>{
 const x=setup();await x.sign();
 // Fixture superuser can temporarily disable a trigger, the runtime service
 // role cannot. This isolates SQL constraints; no bypass enters product code.
 const a=JSON.parse(h.sql(`select row_to_json(a) from membership_v2_document_acceptances a where document_id='${x.f.p.id}'`));
 h.denied(`begin;alter table membership_v2_pending_purchases disable trigger membership_v2_guard_pending_purchase;
 insert into membership_v2_pending_purchases(id,document_id,source_id,scope_id,original_salesperson_user_id,acceptance_attempt_id,environment,
 source_snapshot,source_digest,created_at,expires_at) values('${crypto.randomUUID()}','${x.f.p.id}','${x.f.sourceId}','${x.f.scopeId}','${h.rep}',
 '${a.attempt_id}','dev',jsonb_build_object('SYNTHETIC',repeat('x',1048576)),
 encode(sha256(convert_to(jsonb_build_object('SYNTHETIC',repeat('x',1048576))::text,'UTF8')),'hex'),clock_timestamp(),clock_timestamp()+interval '1 day');commit;`,
 /source_snapshot_check/);
 assert.equal(h.sql(`select count(*) from membership_v2_pending_purchases where document_id='${x.f.p.id}'`),'0');
 assert.equal(h.sql("select tgenabled from pg_trigger where tgname='membership_v2_guard_pending_purchase'"),'O');
});
