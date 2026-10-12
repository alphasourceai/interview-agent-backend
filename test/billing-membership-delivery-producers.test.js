'use strict';
// Real disposable PG/native RPCs; synthetic Auth callback/artifact bytes/sender.
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const h=require('./fixtures/retail-signing-pg'),{canonical,sha}=require('./fixtures/retail-review-fixture');
const {createMembershipCapabilityEnvelope}=require('../src/services/membershipCapabilityEnvelope');
const {createMembershipSalesProspectService}=require('../src/services/membershipSalesProspects');
const {createMembershipIssuedDocumentService}=require('../src/services/membershipIssuedDocuments');
const {createMembershipQuoteDraftService}=require('../src/services/membershipQuoteDrafts');
const {createMembershipDeliveryWorker}=require('../src/services/membershipDeliveryWorker');
before(()=>{if(process.env.MEMBERSHIP_V2_DISPOSABLE==='true')h.sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261012011336_membership_v2_capability_delivery.sql'),'utf8'));});
const mutations=new Set(['membership_v2_register_source_and_delivery','membership_v2_issue_document_and_delivery']);
function bridge(hooks={}){const calls=[];
  const orders={membership_v2_read_sales_prospect:['p_actor','p_scope','p_source'],membership_v2_register_sales_prospect:['p_id','p_actor','p_scope','p_quote','p_quote_digest','p_previous','p_buyer','p_canonical','p_fingerprint','p_token_hash'],
    membership_v2_register_source_and_delivery:['p_source','p_job','p_envelope'],membership_v2_issue_document_and_delivery:['p_document','p_job','p_envelope'],membership_v2_issue_document:['p_document'],
    membership_v2_verify_sales_email:['p_source','p_token_hash'],membership_v2_claim_delivery:['p_job','p_attempt'],membership_v2_before_delivery_send:['p_job','p_attempt'],
    membership_v2_read_delivery_attempt:['p_job','p_attempt'],membership_v2_record_delivery_result:['p_job','p_attempt','p_outcome','p_reference']};
  const db={from(table){assert.match(table,/^[a-z_0-9]+$/);return {select(fields){assert.match(fields,/^(\*|[a-z_0-9,]+)$/);const filters=[];
    const q={eq(k,v){assert.match(k,/^[a-z_]+$/);filters.push(`${k}=${h.literal(v)}`);return q;},is(k,v){assert.equal(v,null);filters.push(`${k} is null`);return q;},async maybeSingle(){
      calls.push(`read:${table}`);if(hooks.beforeRead)await hooks.beforeRead(table);
      if(hooks.missingJob && table==='membership_v2_delivery_jobs')return {data:null,error:null};
      const rows=JSON.parse(h.sql(`set role service_role;select coalesce(json_agg(t),'[]') from (select ${fields} from ${table} where ${filters.join(' and ')}) t;`));
      assert.ok(rows.length<=1);const data=rows[0]||null;if(hooks.row)hooks.row(table,data);return {data,error:null};}};return q;}};},
    async rpc(name,p){calls.push(name);const order=orders[name];assert.ok(order,name);if(hooks.beforeRPC)await hooks.beforeRPC(name,p);
      if(hooks.absent===name)return {error:{code:'NETWORK'}};
      const expr=`${name}(${order.map(k=>h.literal(p[k])).join(',')})`,scalar=name==='membership_v2_before_delivery_send';
      const raw=h.run(`set role service_role;select ${scalar?expr:`coalesce(json_agg(t),'[]') from ${expr} t`};`);
      if(raw.status)return {error:{code:'P0001',message:raw.stderr.includes('sales_source_conflict')?'sales_source_conflict':'synthetic native denial'}};
      const data=scalar?raw.stdout.trim()==='t':JSON.parse(raw.stdout);
      if(hooks.afterRPC)await hooks.afterRPC(name,p,data);
      if(hooks.unknown===name){if(hooks.thrown)throw Error('synthetic lost ACK');return {error:{code:'NETWORK'}};}
      if(hooks.ack)hooks.ack(name,data);return {data,error:null};}};
  return {db,calls};
}
function setup(hooks={},selection={}){
  const seed=h.source(selection),keyId='synthetic-'+crypto.randomUUID(),key=crypto.randomBytes(32);
  h.sql(`set role service_role;insert into membership_v2_delivery_keys(environment,key_id,physical_key_fingerprint,seal_limit)
    values('dev','${keyId}','${sha(key)}',${hooks.limit||100});`);
  const envelope=createMembershipCapabilityEnvelope({environment:'dev',activeKeyId:keyId,keys:{[keyId]:key}});
  const delivery={environment:'dev',envelope},b=bridge(hooks),ctx={scope_id:seed.scopeId,audience:'sales',issuer_user_id:h.rep,
    original_salesperson_user_id:h.rep,client_id:null,billing_owner_user_id:null};let authCount=0,legacy=0;
  const authorizeScope=async()=>{authCount++;if(hooks.authError?.(authCount))throw Error('synthetic Auth denial');return {...ctx};};
  const prospect=createMembershipSalesProspectService({db:b.db,authorizeScope,delivery,handoffVerification:async()=>{legacy++;}});
  const input={quoteId:seed.quote.quote_id,expectedSourceId:null,buyer:seed.source.buyer},subject={accessToken:'SYNTHETIC',scopeId:seed.scopeId};
  const objects=new Map();let l=null;
  function issuer(){
    if(!l){const version='retail-membership-issued-synthetic-'+crypto.randomUUID();
      h.sql(`set role service_role;${h.insert('membership_v2_legal_versions',{version,template_sha256:sha('SYNTHETIC TEMPLATE'),refund_policy_version:'synthetic-v1',
        refund_policy_reference:'https://example.invalid/policy',refund_policy_sha256:sha('SYNTHETIC POLICY'),approval_reference:'SYNTHETIC ONLY'})}`);
      l=JSON.parse(h.sql(`set role service_role;select row_to_json(t) from membership_v2_legal_versions t where version='${version}';`));}
    const quote=createMembershipQuoteDraftService({db:b.db,authorizeScope});
    return createMembershipIssuedDocumentService({db:b.db,authorizeScope,loadSource:(s,id)=>prospect.readProspect(s,id),loadQuote:(s,id)=>quote.readQuote(s,id),
      legalVersion:l.version,loadPublishedLegal:async()=>l,delivery,
      renderIssuedDocument:async data=>({protocol:'retail_issued_artifact_v2',document_id:data.documentId,source_fingerprint:data.snapshot.source_fingerprint,
        quote_digest:data.snapshot.quote_digest,legal_version:data.legal.version,template_sha256:data.legal.template_sha256,
        html:'<html>SYNTHETIC issued content</html>',pdf_bytes:Buffer.from('%PDF-1.7\nSYNTHETIC TEST ONLY\n%%EOF')}),
      artifacts:{putIfAbsent:async(p,bytes)=>{assert.ok(!objects.has(p));objects.set(p,Buffer.from(bytes));},readPrivate:async p=>objects.get(p)}});
  }
  const job=id=>JSON.parse(h.sql(`set role service_role;select row_to_json(t) from membership_v2_delivery_jobs t where id='${id}';`));
  const token=id=>{const j=job(id);return envelope.open({envelope:j.sealed_envelope,binding:j.sealed_envelope.binding});};
  async function createVerified(){const r=await prospect.createProspect(subject,input);await prospect.verifyEmail({sourceId:r.source.source_id,token:token(r.delivery_job_id)});return r;}
  return {...b,seed,keyId,envelope,delivery,ctx,subject,input,prospect,issuer,job,token,objects,createVerified,legacy:()=>legacy};
}
function safe(result,tokens=[]){const text=JSON.stringify(result);assert.equal(result.signing_enabled,false);assert.equal(result.checkout_enabled,false);
  assert.equal(result.delivery,'reserved');assert.equal(result.recipient_delivery_confirmed,false);assert.equal(result.automatic_retry_allowed,false);
  for(const token of tokens)assert.ok(!text.includes(token));for(const k of ['sealed_envelope','nonce','key_id','token_hash','provider_reference'])assert.ok(!text.includes(`"${k}"`));}
test('queued configuration explicit and malformed/null config never falls back to legacy handoff',()=>{
  for(const delivery of [null,{}, {environment:'dev',envelope:{}},{environment:'qa',envelope:{seal(){},keyIdentity(){}}}]){
    assert.throws(()=>createMembershipSalesProspectService({db:{from(){},rpc(){}},authorizeScope(){},handoffVerification(){},delivery}),e=>e.code==='membership_delivery_reservation_held');
    assert.throws(()=>createMembershipIssuedDocumentService({delivery}),e=>e.code==='membership_delivery_reservation_held');}
  const envelope=createMembershipCapabilityEnvelope({environment:'staging',activeKeyId:'synthetic',keys:{synthetic:crypto.randomBytes(32)}});
  assert.throws(()=>createMembershipSalesProspectService({db:{from(){},rpc(){}},authorizeScope(){},delivery:{environment:'dev',envelope}}),e=>e.code==='membership_delivery_reservation_held');envelope.destroy();
});
test('actual producer contact -> verification -> issued document -> fake worker: one atomic job each, zero unpaid access',h.opts,async()=>{
  const f=setup(),r=await f.createVerified(),issued=await f.issuer().issue(f.subject,{sourceId:r.source.source_id});
  safe(r,[f.token(r.delivery_job_id)]);safe(issued,[f.token(issued.delivery_job_id)]);assert.equal(f.legacy(),0);
  assert.equal(f.calls.filter(c=>c==='membership_v2_register_source_and_delivery').length,1);
  assert.equal(f.calls.filter(c=>c==='membership_v2_issue_document_and_delivery').length,1);
  assert.ok(!f.calls.includes('membership_v2_register_sales_prospect'));assert.ok(!f.calls.includes('membership_v2_issue_document'));
  assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${f.keyId}';`),'2');
  const stored=JSON.parse(h.sql(`select row_to_json(t) from membership_v2_issued_documents t where id='${issued.document_id}';`));
  assert.equal(sha(f.objects.get(stored.preview_pdf_path)),stored.preview_pdf_sha256);
  const sent=[],w=createMembershipDeliveryWorker({db:f.db,environment:'dev',origin:'https://interview-agent-frontend-qa.onrender.com',
    allowRecipients:[f.input.buyer.buyer_email],envelope:f.envelope,send:async p=>{sent.push(p);return {status:'accepted',reference:'synthetic-ack'};}});
  assert.equal((await w.process({jobId:r.delivery_job_id})).state,'skipped_obsolete');
  const ack=await w.process({jobId:issued.delivery_job_id});assert.equal(ack.state,'accepted_by_provider');assert.equal(ack.recipient_delivery_confirmed,false);
  assert.equal(sent.length,1);assert.equal(new URL(sent[0].link).hash,`#token=${f.token(issued.delivery_job_id)}`);
  assert.equal(h.sql('select count(*) from auth.users;'),'2');assert.equal(h.sql('select count(*) from clients;'),'1');assert.equal(h.sql('select count(*) from membership_v2_contracts;'),'0');f.envelope.destroy();
});
for(const purpose of ['contact','signing'])for(const thrown of [false,true])test(`${purpose}: actual committed ${thrown?'thrown':'returned'} unknown ACK recovers one immutable job, no retry/send`,h.opts,async()=>{
  const name=purpose==='contact'?'membership_v2_register_source_and_delivery':'membership_v2_issue_document_and_delivery';
  const hooks={},f=setup(hooks);let result;
  if(purpose==='signing'){const r=await f.createVerified();hooks.unknown=name;hooks.thrown=thrown;f.calls.length=0;result=await f.issuer().issue(f.subject,{sourceId:r.source.source_id});}
  else {hooks.unknown=name;hooks.thrown=thrown;result=await f.prospect.createProspect(f.subject,f.input);}
  assert.equal(result.persistence,'recovered_unknown_commit');safe(result,[f.token(result.delivery_job_id)]);
  assert.equal(f.calls.filter(c=>c===name).length,1);assert.equal(f.calls.filter(c=>c==='read:membership_v2_delivery_jobs').length,1);assert.equal(f.legacy(),0);f.envelope.destroy();
});
test('missing commit or unreadable job after commit holds both producers and never retries or handoffs',h.opts,async()=>{
  for(const purpose of ['contact','signing'])for(const absent of [false,true]){
    const hooks={},f=setup(hooks),name=purpose==='contact'?'membership_v2_register_source_and_delivery':'membership_v2_issue_document_and_delivery';let run;
    if(purpose==='signing'){const r=await f.createVerified();run=()=>f.issuer().issue(f.subject,{sourceId:r.source.source_id});}
    else run=()=>f.prospect.createProspect(f.subject,f.input);
    if(absent)hooks.absent=name;else {hooks.unknown=name;hooks.missingJob=true;}f.calls.length=0;
    await assert.rejects(run);assert.equal(f.calls.filter(c=>c===name).length,1);assert.equal(f.legacy(),0);
    assert.ok(!f.calls.some(c=>c==='membership_v2_register_sales_prospect'||c==='membership_v2_issue_document'));f.envelope.destroy();
  }
});
test('wrong owned physical key, retired key and exhausted budget hold before source mutation',h.opts,async()=>{
  for(const mode of ['wrong','retired','exhausted']){const f=setup({limit:1});
    if(mode==='wrong'){f.envelope.destroy();f.delivery.envelope=createMembershipCapabilityEnvelope({environment:'dev',activeKeyId:f.keyId,keys:{[f.keyId]:crypto.randomBytes(32)}});}
    if(mode==='retired')h.sql(`set role service_role;update membership_v2_delivery_keys set retired=true where key_id='${f.keyId}';`);
    if(mode==='exhausted'){h.sql(`set role service_role;update membership_v2_delivery_keys set used_count=used_count+1 where key_id='${f.keyId}';`);}
    const service=createMembershipSalesProspectService({db:f.db,authorizeScope:async()=>f.ctx,delivery:f.delivery});
    await assert.rejects(()=>service.createProspect(f.subject,f.input),e=>e.code==='membership_delivery_reservation_held');
    assert.equal(f.calls.filter(c=>mutations.has(c)).length,0);assert.equal(h.sql(`select count(*) from membership_v2_sales_prospects where scope_id='${f.seed.scopeId}';`),'0');f.delivery.envelope.destroy();
  }
});
test('retirement between producer preflight and native insertion rolls back parent and budget',h.opts,async()=>{
  for(const purpose of ['contact','signing']){const hooks={},f=setup(hooks);let run;
    if(purpose==='signing'){const r=await f.createVerified();run=()=>f.issuer().issue(f.subject,{sourceId:r.source.source_id});}else run=()=>f.prospect.createProspect(f.subject,f.input);
    const before=h.sql(`select used_count from membership_v2_delivery_keys where key_id='${f.keyId}';`);f.calls.length=0;
    hooks.beforeRPC=n=>{if(mutations.has(n))h.sql(`set role service_role;update membership_v2_delivery_keys set retired=true where key_id='${f.keyId}';`);};
    await assert.rejects(run);assert.equal(h.sql(`select used_count from membership_v2_delivery_keys where key_id='${f.keyId}';`),before);
    assert.equal(f.calls.filter(c=>mutations.has(c)).length,1);assert.equal(f.legacy(),0);f.envelope.destroy();
  }
});
test('safe ACK and exact owned immutable job tampering hold without additional mutation',h.opts,async()=>{
  for(const mode of ['ack','job','cipher','scope']){const hooks={},f=setup(hooks);
    if(mode==='ack')hooks.ack=(n,a)=>{if(mutations.has(n))a[0].job_id=crypto.randomUUID();};
    else hooks.row=(table,row)=>{if(table==='membership_v2_delivery_jobs'){
      if(mode==='job')row.subject_id=crypto.randomUUID();if(mode==='scope')row.scope_id=crypto.randomUUID();if(mode==='cipher')row.sealed_envelope.ciphertext='A'.repeat(58);}};
    await assert.rejects(()=>f.prospect.createProspect(f.subject,f.input),e=>e.code==='membership_delivery_reservation_held');
    assert.equal(f.calls.filter(c=>mutations.has(c)).length,1);assert.equal(f.legacy(),0);f.envelope.destroy();
  }
});
test('postcommit retirement preserves truthful reservation only; independent worker blocks sender',h.opts,async()=>{
  const hooks={},f=setup(hooks);hooks.afterRPC=n=>{if(n==='membership_v2_register_source_and_delivery')h.sql(`set role service_role;update membership_v2_delivery_keys set retired=true where key_id='${f.keyId}';`);};
  const r=await f.prospect.createProspect(f.subject,f.input);safe(r);
  let sends=0;const w=createMembershipDeliveryWorker({db:f.db,environment:'dev',origin:'https://interview-agent-frontend-qa.onrender.com',
    allowRecipients:[f.input.buyer.buyer_email],envelope:f.envelope,send:async()=>{sends++;return {status:'accepted',reference:'synthetic'};}});
  await assert.rejects(()=>w.process({jobId:r.delivery_job_id}));assert.equal(sends,0);assert.equal(f.legacy(),0);f.envelope.destroy();
});
test('all 24 retail selections preserve server quote and separate first-role amounts through queued issuance',h.opts,async()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments'])for(const firstRolePrepaySelected of [false,true]){
    const f=setup({}, {planKey,commitmentMonths,paymentOption,firstRolePrepaySelected});
    const r=await f.createVerified(),d=await f.issuer().issue(f.subject,{sourceId:r.source.source_id});
    const stored=JSON.parse(h.sql(`select quote_snapshot from membership_v2_issued_documents where id='${d.document_id}';`));
    assert.equal(canonical(stored),canonical(f.seed.quote));assert.equal(stored.offer.first_role_prepay.selected,firstRolePrepaySelected);
    safe(r,[f.token(r.delivery_job_id)]);safe(d,[f.token(d.delivery_job_id)]);assert.equal(f.legacy(),0);f.envelope.destroy();
  }
});
test('final fresh authorization failure cannot expose committed job response or invoke old callback',h.opts,async()=>{
  for(const purpose of ['contact','signing']){const hooks={},f=setup(hooks);let run;
    if(purpose==='signing'){const r=await f.createVerified();run=()=>f.issuer().issue(f.subject,{sourceId:r.source.source_id});}else run=()=>f.prospect.createProspect(f.subject,f.input);
    hooks.beforeRead=table=>{if(table==='membership_v2_delivery_jobs')hooks.authError=()=>true;};f.calls.length=0;
    await assert.rejects(run,e=>['sales_prospect_denied','issued_scope_denied'].includes(e.code));
    assert.equal(f.calls.filter(c=>mutations.has(c)).length,1);assert.equal(f.legacy(),0);f.envelope.destroy();
  }
});
test('signing queue ACK/envelope/document crossing holds exact immutable readback without another issue',h.opts,async()=>{
  for(const mode of ['ack','cipher','document']){const hooks={},f=setup(hooks),r=await f.createVerified();f.calls.length=0;
    if(mode==='ack')hooks.ack=(n,a)=>{if(n==='membership_v2_issue_document_and_delivery')a[0].document_id=crypto.randomUUID();};
    else hooks.row=(table,row)=>{if(table==='membership_v2_delivery_jobs'){
      if(mode==='cipher')row.sealed_envelope.tag='A'.repeat(22);else row.document_id=crypto.randomUUID();}};
    await assert.rejects(()=>f.issuer().issue(f.subject,{sourceId:r.source.source_id}),e=>e.code==='membership_delivery_reservation_held');
    assert.equal(f.calls.filter(c=>c==='membership_v2_issue_document_and_delivery').length,1);assert.equal(f.legacy(),0);f.envelope.destroy();
  }
});
test('wrong actual scope owner and stale source CAS cannot durably reserve a queued source',h.opts,async()=>{
  const f=setup(),first=await f.prospect.createProspect(f.subject,f.input);
  await assert.rejects(()=>f.prospect.createProspect(f.subject,f.input),e=>e.code==='sales_prospect_conflict');
  assert.equal(h.sql(`select count(*) from membership_v2_delivery_jobs where scope_id='${f.ctx.scope_id}';`),'1');
  const g=createMembershipSalesProspectService({db:f.db,authorizeScope:async()=>({...f.ctx,issuer_user_id:h.other,original_salesperson_user_id:h.other}),delivery:f.delivery});
  await assert.rejects(()=>g.createProspect(f.subject,f.input));assert.equal(h.sql(`select count(*) from membership_v2_delivery_jobs where scope_id='${f.ctx.scope_id}';`),'1');
  // Parent ledger intentionally allows only one source per immutable quote.
  // A deliberate replacement needs a fresh quote AND explicit current-head CAS.
  const next=h.source({},first.source.source_id,f.ctx.scope_id);
  const currentInput={...f.input,quoteId:next.quote.quote_id,expectedSourceId:first.source.source_id},second=await f.prospect.createProspect(f.subject,currentInput);
  assert.notEqual(second.source.source_id,first.source.source_id);let sends=0;
  const w=createMembershipDeliveryWorker({db:f.db,environment:'dev',origin:'https://interview-agent-frontend-qa.onrender.com',allowRecipients:[f.input.buyer.buyer_email],
    envelope:f.envelope,send:async()=>{sends++;return {status:'accepted',reference:'synthetic'};}});
  await assert.rejects(()=>w.process({jobId:first.delivery_job_id}));assert.equal(sends,0);assert.equal(f.legacy(),0);f.envelope.destroy();
});
