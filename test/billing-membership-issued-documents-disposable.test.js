'use strict';
// Actual disposable PostgreSQL, real parent migrations/RPCs. SYNTHETIC HTML,
// PDF/signature hashes and publication descriptor only; not real signed PDFs,
// Supabase Auth/storage, published legal approval or provider acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,spawn}=require('node:child_process'),{test,before,after}=require('node:test');
const {fixture:offerFixture,canonical,sha}=require('./fixtures/retail-review-fixture');
const {createMembershipIssuedDocumentService}=require('../src/services/membershipIssuedDocuments');
const enabled=process.env.MEMBERSHIP_V2_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port=process.env.PGPORT||'55440',PG='/opt/homebrew/opt/postgresql@17/bin/';
const database=`alphascreen_issued_documents_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const rep='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const migration='20261011230250_membership_v2_issued_documents.sql';
let baseline;
function args(){return ['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-d',database];}
function run(q){return spawnSync(`${PG}psql`,[...args(),'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function literal(v){return v===null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
  typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;}
function denied(q,re){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function asyncSQL(q){let out='',err='';const child=spawn(`${PG}psql`,[...args(),'-c',q]);
  const done=new Promise((resolve,reject)=>{child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);
    child.on('error',reject);child.on('close',status=>resolve({status,out:out.trim(),err}));});return {child,done};}
async function blocked(tag){for(let i=0;i<30;i++){
  if(sql(`select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
    and query like '%${tag}%' and wait_event_type='Lock';`)!=='0')return;
  await new Promise(resolve=>setTimeout(resolve,10));
}assert.fail(`No forced lock overlap observed for ${tag}`);}
async function sleeping(tag){for(let i=0;i<30;i++){
  if(sql(`select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
    and query like '%${tag}%' and wait_event='PgSleep';`)!=='0')return;
  await new Promise(resolve=>setTimeout(resolve,10));
}assert.fail(`No held transaction observed for ${tag}`);}
const rpc=(name,p)=>`select row_to_json(t) from public.${name}(${literal(p)}) t;`;
function parents(){return sql(`select jsonb_build_object('parents',(select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in ('sales_reps'::regclass,'membership_v2_sales_quote_scopes'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'public_purchase_intents'::regclass,'membership_agreements'::regclass)),
  'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'def',pg_get_constraintdef(oid)) order by conname) from pg_constraint
    where conrelid in ('sales_reps'::regclass,'membership_v2_sales_quote_scopes'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'public_purchase_intents'::regclass,'membership_agreements'::regclass)),
  'legacy',(select jsonb_agg(to_jsonb(c)) from clients c),'agreements',(select jsonb_agg(to_jsonb(a)) from membership_agreements a),
  'intents',(select jsonb_agg(to_jsonb(i)) from public_purchase_intents i));`);}
function insert(table,row){return `insert into public.${table}(${Object.keys(row).join(',')}) values(${Object.values(row).map(literal).join(',')});`;}
function source(selection={},previous=null,scope=null,actor=rep){
  const f=offerFixture(selection),scopeId=scope||crypto.randomUUID(),id=crypto.randomUUID(),quoteId=crypto.randomUUID();
  if(!scope){const key=sha(crypto.randomBytes(32));sql(`set role service_role;select id from membership_v2_reserve_sales_quote_scope('${actor}','${key}',
    '${sha(`manual-prospect-scope-v1\n${actor}\nsales\nmanual_prospect`)}');`);
    // The reservation chooses a UUID; use its authoritative row identity.
    const stored=JSON.parse(sql(`set role service_role;select row_to_json(t) from membership_v2_sales_quote_scopes t where issuer_user_id='${actor}' and idempotency_key_hash='${key}';`));
    return source(selection,previous,stored.id,actor);
  }
  const instant=sql(`select to_char(date_trunc('milliseconds',clock_timestamp()) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
  const quote={...f.quoteReply.quote,quote_id:quoteId,scope_id:scopeId,issuer_user_id:actor,original_salesperson_user_id:actor,
    issued_at:instant,expires_at:new Date(Date.parse(instant)+1800000).toISOString()};
  const qb=canonical(quote),qd=sha(qb);
  sql(`set role service_role;${insert('membership_v2_quote_drafts',{id:quoteId,scope_id:scopeId,audience:'sales',issuer_user_id:actor,
    original_salesperson_user_id:actor,client_id:null,billing_owner_user_id:null,offer_snapshot:quote.offer,
    template_version:quote.template_version,template_status:quote.template_status,issued_at:quote.issued_at,expires_at:quote.expires_at,canonical_quote:qb,quote_digest:qd})}`);
  const s={...f.sourceReply.source,source_id:id,scope_id:scopeId,issuer_user_id:actor,original_salesperson_user_id:actor,
    quote_id:quoteId,quote_digest:qd,previous_source_id:previous};
  const sb=canonical(s),sf=sha(sb),tokenHash=sha(crypto.randomBytes(32));
  const statement=`select id from membership_v2_register_sales_prospect('${id}','${actor}','${scopeId}','${quoteId}','${qd}',${literal(previous)},
    ${literal(s.buyer)},${literal(sb)},'${sf}','${tokenHash}');`;
  return {source:s,quote,sourceId:id,scopeId,actor,sourceFingerprint:sf,tokenHash,register:statement,
    verify:`select source_id from membership_v2_verify_sales_email('${id}','${tokenHash}');`};
}
function legal(){const version=`retail-membership-issued-synthetic-${crypto.randomUUID()}`;
  sql(`set role service_role;${insert('membership_v2_legal_versions',{version,template_sha256:sha('SYNTHETIC TEMPLATE'),
    refund_policy_version:'SYNTHETIC-NOT-PUBLISHED',refund_policy_reference:'https://example.invalid/synthetic-policy',
    refund_policy_sha256:sha('SYNTHETIC POLICY'),approval_reference:'SYNTHETIC FIXTURE ONLY - NOT LEGAL APPROVAL'})}`);return version;}
function setup(selection={},verify=true){const f=source(selection);sql(`set role service_role;${f.register}${verify?f.verify:''}`);
  const id=crypto.randomUUID(),html='<html><body>SYNTHETIC issued body for ledger test only</body></html>';
  f.p={id,source_id:f.sourceId,source_fingerprint:f.sourceFingerprint,scope_id:f.scopeId,issuer_user_id:f.actor,
    legal_version:legal(),rendered_html:html,html_sha256:sha(html),preview_pdf_path:`retail-v2/${id}/preview.pdf`,
    preview_pdf_sha256:sha('SYNTHETIC PDF'),preview_pdf_size:40,signer_token_hash:sha(`retail-signing-v2\n${id}\n${f.sourceFingerprint}\nSYNTHETIC_TOKEN`)};
  f.issue=()=>JSON.parse(sql(`set role service_role;${rpc('membership_v2_issue_document',f.p)}`));return f;}
function acceptance(f,change={}){const id=f.p.id,attempt=crypto.randomUUID();return {document_id:id,source_id:f.sourceId,attempt_id:attempt,
  signer_token_hash:f.p.signer_token_hash,source_fingerprint:f.sourceFingerprint,html_sha256:f.p.html_sha256,
  preview_pdf_sha256:f.p.preview_pdf_sha256,consent:true,typed_name:'Demo Buyer',
  signature_path:`retail-v2/${id}/attempts/${attempt}/signature.png`,signature_sha256:sha('SYNTHETIC SIGNATURE'),signature_size:32,
  executed_pdf_path:`retail-v2/${id}/attempts/${attempt}/executed.pdf`,executed_pdf_sha256:sha('SYNTHETIC EXECUTED PDF'),executed_pdf_size:40,...change};}
const accept=(a)=>JSON.parse(sql(`set role service_role;${rpc('membership_v2_accept_document',a)}`));
function moveQuotePast(f){sql(`alter table membership_v2_quote_drafts disable trigger membership_v2_quote_drafts_immutable;
  update membership_v2_quote_drafts set issued_at=issued_at-interval '1 day',expires_at=expires_at-interval '1 day',
    canonical_quote=public.membership_v2_quote_canonical((canonical_quote::jsonb)||jsonb_build_object(
      'issued_at',to_char((issued_at-interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expires_at',to_char((expires_at-interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    quote_digest=encode(sha256(convert_to(public.membership_v2_quote_canonical((canonical_quote::jsonb)||jsonb_build_object(
      'issued_at',to_char((issued_at-interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expires_at',to_char((expires_at-interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),'UTF8')),'hex')
    where id='${f.quote.quote_id}';alter table membership_v2_quote_drafts enable trigger membership_v2_quote_drafts_immutable;`);}
before(()=>{if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
  const r=spawnSync(`${PG}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key,status text);
    create table membership_agreements(id uuid primary key,client_id uuid references clients(id),status text);
    create table public_purchase_intents(id uuid primary key,client_id uuid references clients(id),protocol text,selected_billing_cadence text);
    insert into auth.users values('${rep}'),('${other}');insert into clients values(gen_random_uuid(),'active');
    insert into membership_agreements values(gen_random_uuid(),null,'signed');insert into public_purchase_intents values(gen_random_uuid(),null,'fenced_v2','annual');
    grant usage on schema public,auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  const sales=fs.readFileSync(path.join(root,'20260918195401_sales_workspace.sql'),'utf8');sql(sales.slice(0,sales.indexOf('alter table public.public_purchase_intents')));
  sql(`alter table sales_reps enable row level security;revoke all on sales_reps from public,anon,authenticated,service_role;
    grant select,update on sales_reps to service_role;insert into sales_reps(user_id,email,display_name)
      values('${rep}','rep@example.invalid','Synthetic Rep'),('${other}','other@example.invalid','Synthetic Other');`);
  for(const file of ['20261011163625_membership_v2_contract_store.sql','20261011194051_membership_v2_quote_drafts.sql',
    '20261011201754_membership_v2_sales_quote_scopes.sql','20261011211123_membership_v2_sales_prospects.sql',migration]){
    if(file===migration)baseline=parents();const result=spawnSync(`${PG}psql`,[...args(),'-f',path.join(root,file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
});
after(()=>{if(!enabled)return;const r=spawnSync(`${PG}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});

test('all24 retail choices freeze complete DB source/offer/legal snapshots, exact HTML and no paid dates',opts,()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments'])for(const firstRolePrepay of [false,true]){
    const f=setup({planKey,commitmentMonths,paymentOption,firstRolePrepay}),d=f.issue();
    assert.deepEqual(d.source_snapshot,f.source);assert.deepEqual(d.quote_snapshot,f.quote);
    assert.equal(d.legal_snapshot.version,f.p.legal_version);assert.equal(d.rendered_html,f.p.rendered_html);
    assert.equal(d.html_sha256,sha(d.rendered_html));assert.equal(d.source_snapshot.original_salesperson_user_id,rep);
    assert.equal(d.quote_snapshot.offer.term_start_basis,'first_payment_success');assert.equal('term_start' in d,false);
    assert.equal(sql(`select expires_at=membership_v2_signing_deadline(issued_at) from membership_v2_issued_documents where id='${d.id}';`),'t');
  }
});
test('draft/review legal version, unknown/revoked legal descriptor and no contact proof held',opts,()=>{
  const f=setup({},false);denied(`set role service_role;${rpc('membership_v2_issue_document',f.p)}`,/issued_document_denied/);
  sql(`set role service_role;${f.verify}`);
  denied(`set role service_role;${rpc('membership_v2_issue_document',{...f.p,legal_version:'unknown'})}`,/issued_document_legal_unavailable/);
  denied(`set role service_role;${insert('membership_v2_legal_versions',{version:'retail-membership-review-2026-10-11-v1',template_sha256:sha('x'),
    refund_policy_version:'x',refund_policy_reference:'https://example.invalid/p',refund_policy_sha256:sha('p'),approval_reference:'not approved'})}`,/check constraint/);
  sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${f.p.legal_version}','Synthetic revocation');`);
  denied(`set role service_role;${rpc('membership_v2_issue_document',f.p)}`,/issued_document_legal_unavailable/);
});
test('wrong actor/scope/source/fingerprint, HTML digest, foreign path and oversized PDF held atomically',opts,()=>{
  const f=setup();for(const change of [{issuer_user_id:other},{scope_id:crypto.randomUUID()},{source_id:crypto.randomUUID()},
    {source_fingerprint:sha('wrong')},{preview_pdf_path:'https://example.invalid/foreign'},
    {preview_pdf_size:8388609},{preview_pdf_size:15},{signer_token_hash:'raw-token'}])
    denied(`set role service_role;${rpc('membership_v2_issue_document',{...f.p,...change})}`,/issued_document_denied|check constraint/);
  assert.equal(sql(`select count(*) from membership_v2_issued_documents where source_id='${f.sourceId}';`),'0');
});
test('direct service insert cannot forge snapshots or backdate/extend deadline',opts,()=>{
  const f=setup(),row={...f.p,html_sha256:sha('forged'),source_snapshot:{forged:true},quote_snapshot:{forged:true},legal_snapshot:{forged:true},
    issued_at:'2000-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z'};
  sql(`set role service_role;${insert('membership_v2_issued_documents',row)}`);
  const d=JSON.parse(sql(`set role service_role;select row_to_json(t) from membership_v2_issued_documents t where id='${f.p.id}';`));
  assert.deepEqual(d.source_snapshot,f.source);assert.deepEqual(d.quote_snapshot,f.quote);assert.equal(d.legal_snapshot.version,f.p.legal_version);
  assert.equal(d.html_sha256,sha(d.rendered_html));
  assert.ok(Date.parse(d.issued_at)>Date.parse('2026-01-01'));assert.ok(Date.parse(d.expires_at)<Date.parse(d.issued_at)+86400001);
});
test('Denver next-midnight deadline is DST-aware and matches current sales policy',opts,()=>{
  for(const [issue,expected] of [['2026-03-08T06:59:59Z','2026-03-08T07:00:00Z'],
    ['2026-03-08T07:00:00Z','2026-03-09T06:00:00Z'],
    ['2026-03-08T08:00:00Z','2026-03-09T06:00:00Z'],['2026-11-01T07:00:00Z','2026-11-02T07:00:00Z']]){
    const actual=sql(`select to_char(membership_v2_signing_deadline('${issue}') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');`);
    assert.equal(actual,expected);
  }
});
test('same source cannot issue a second document or replace preview bytes',opts,()=>{
  const f=setup(),d=f.issue();denied(`set role service_role;${rpc('membership_v2_issue_document',f.p)}`,/unique constraint/);
  const id=crypto.randomUUID();denied(`set role service_role;${rpc('membership_v2_issue_document',{...f.p,id,preview_pdf_path:`retail-v2/${id}/preview.pdf`,signer_token_hash:sha('different')})}`,/unique constraint/);
  assert.equal(sql(`select preview_pdf_sha256 from membership_v2_issued_documents where id='${d.id}';`),f.p.preview_pdf_sha256);
});
test('exact acceptance and same-attempt replay choose unchanged winning timestamp/evidence',opts,()=>{
  const f=setup();f.issue();const p=acceptance(f),a=accept(p),b=accept(p);assert.deepEqual(a,b);
  assert.equal(a.typed_name,'Demo Buyer');assert.equal(sql(`select count(*) from membership_v2_document_acceptances where source_id='${f.sourceId}';`),'1');
  for(const change of [{attempt_id:crypto.randomUUID()},{typed_name:'Different'},{signature_sha256:sha('different')}])
    denied(`set role service_role;${rpc('membership_v2_accept_document',{...p,...change})}`,/document_acceptance_conflict/);
});
test('wrong token/source/hash, false or null consent, foreign attempt paths and unsafe name deny',opts,()=>{
  const f=setup();f.issue();const a=acceptance(f);
  for(const change of [{signer_token_hash:sha('wrong')},{source_id:crypto.randomUUID()},{source_fingerprint:sha('wrong')},
    {html_sha256:sha('wrong')},{preview_pdf_sha256:sha('wrong')},{consent:false},{consent:null},{consent:'true'},
    {signature_path:'retail-v2/other/signature.png'},{executed_pdf_path:'https://example.invalid/executed.pdf'},
    {typed_name:'Demo\u202eBuyer'},{signature_size:2097153}])
    denied(`set role service_role;${rpc('membership_v2_accept_document',{...a,...change})}`,/document_acceptance_denied|check constraint|not-null constraint/);
  assert.equal(sql(`select count(*) from membership_v2_document_acceptances where document_id='${f.p.id}';`),'0');
});
test('two concurrent signature attempts have one winner and immutable per-attempt paths',opts,async()=>{
  const f=setup();f.issue();const candidates=[acceptance(f),acceptance(f)];
  const results=await Promise.all(candidates.map(a=>asyncSQL(`set role service_role;${rpc('membership_v2_accept_document',a)}`).done));
  assert.equal(results.filter(r=>r.status===0).length,1);assert.match(results.find(r=>r.status!==0).err,/document_acceptance_conflict/);
  const winner=JSON.parse(results.find(r=>r.status===0).out);assert.ok(candidates.some(a=>a.signature_path===winner.signature_path));
  assert.equal(sql(`select count(*) from membership_v2_document_acceptances where document_id='${f.p.id}';`),'1');
});
test('accepted source rejects CAS replacement and rolls back all new source/challenge writes',opts,()=>{
  const f=setup();f.issue();accept(acceptance(f));const next=source({},f.sourceId,f.scopeId);
  denied(`set role service_role;${next.register}`,/accepted_sales_source_immutable/);
  assert.equal(sql(`select current_source_id from membership_v2_sales_prospect_heads where scope_id='${f.scopeId}';`),f.sourceId);
  assert.equal(sql(`select count(*) from membership_v2_sales_prospects where id='${next.sourceId}';`),'0');
  assert.equal(sql(`select count(*) from membership_v2_sales_email_challenges where source_id='${next.sourceId}';`),'0');
});
test('replacement before acceptance invalidates old signer even with matching hashes',opts,()=>{
  const f=setup();f.issue();const next=source({},f.sourceId,f.scopeId);sql(`set role service_role;${next.register}`);
  denied(`set role service_role;${rpc('membership_v2_accept_document',acceptance(f))}`,/document_acceptance_denied/);
});
test('actual acceptance versus replacement race linearizes exactly one outcome',opts,async()=>{
  for(let i=0;i<4;i++){
    const f=setup();f.issue();const next=source({},f.sourceId,f.scopeId),a=acceptance(f);
    const results=await Promise.all([asyncSQL(`set role service_role;${rpc('membership_v2_accept_document',a)}`).done,
      asyncSQL(`set role service_role;${next.register}`).done]);
    assert.equal(results.filter(r=>r.status===0).length,1);
    assert.match(results.find(r=>r.status!==0).err,/accepted_sales_source_immutable|document_acceptance_denied/);
  }
});
test('forced acceptance commit while replacement statement waits cannot supersede accepted head',opts,async()=>{
  const f=setup();f.issue();const next=source({},f.sourceId,f.scopeId);
  const first=asyncSQL(`/* HOLDING_ACCEPTED_HEAD */begin;set role service_role;${rpc('membership_v2_accept_document',acceptance(f))}select pg_sleep(0.8);commit;`);
  await sleeping('HOLDING_ACCEPTED_HEAD');
  const second=asyncSQL(`/* FORCED_ACCEPTED_HEAD */set role service_role;${next.register}`);
  await blocked('FORCED_ACCEPTED_HEAD');const [a,b]=await Promise.all([first.done,second.done]);
  assert.equal(a.status,0,a.err);assert.notEqual(b.status,0);assert.match(b.err,/accepted_sales_source_immutable/);
  assert.equal(sql(`select current_source_id from membership_v2_sales_prospect_heads where scope_id='${f.scopeId}';`),f.sourceId);
});
test('revocation committed while issuance statement waits is read from locked latest gate',opts,async()=>{
  const f=setup();const first=asyncSQL(`/* HOLDING_REVOKED_ISSUE */begin;set role service_role;insert into membership_v2_legal_revocations(version,reason)
    values('${f.p.legal_version}','Synthetic forced overlap');select pg_sleep(0.8);commit;`);
  await sleeping('HOLDING_REVOKED_ISSUE');const second=asyncSQL(`/* FORCED_REVOKED_ISSUE */set role service_role;${rpc('membership_v2_issue_document',f.p)}`);
  await blocked('FORCED_REVOKED_ISSUE');const [a,b]=await Promise.all([first.done,second.done]);
  assert.equal(a.status,0,a.err);assert.notEqual(b.status,0);assert.match(b.err,/issued_document_legal_unavailable/);
  assert.equal(sql(`select count(*) from membership_v2_issued_documents where id='${f.p.id}';`),'0');
});
test('revocation committed while acceptance statement waits holds new signing, not stale statement snapshot',opts,async()=>{
  const f=setup();f.issue();const first=asyncSQL(`/* HOLDING_REVOKED_ACCEPT */begin;set role service_role;insert into membership_v2_legal_revocations(version,reason)
    values('${f.p.legal_version}','Synthetic forced overlap');select pg_sleep(0.8);commit;`);
  await sleeping('HOLDING_REVOKED_ACCEPT');const second=asyncSQL(`/* FORCED_REVOKED_ACCEPT */set role service_role;${rpc('membership_v2_accept_document',acceptance(f))}`);
  await blocked('FORCED_REVOKED_ACCEPT');const [a,b]=await Promise.all([first.done,second.done]);
  assert.equal(a.status,0,a.err);assert.notEqual(b.status,0);assert.match(b.err,/document_acceptance_denied/);
  assert.equal(sql(`select count(*) from membership_v2_document_acceptances where document_id='${f.p.id}';`),'0');
});
test('legal gate can only become revoked with immutable history, cannot reopen or change version',opts,()=>{
  const version=legal();
  denied(`set role service_role;update membership_v2_legal_gates set revoked=true where version='${version}';`,/invalid_legal_gate_transition/);
  denied(`set role service_role;update membership_v2_legal_gates set revoked=false where version='${version}';`,/invalid_legal_gate_transition/);
  sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${version}','Synthetic hold');`);
  assert.equal(sql(`select revoked from membership_v2_legal_gates where version='${version}';`),'t');
  denied(`set role service_role;update membership_v2_legal_gates set revoked=false where version='${version}';`,/invalid_legal_gate_transition/);
  denied(`delete from membership_v2_legal_gates where version='${version}';`,/immutable/);
  denied(`truncate membership_v2_legal_gates cascade;`,/immutable/);
});
test('issuer adapter persists through real service-role SQL and recovers unknown commit without another write',opts,async()=>{
  for(const unknown of [false,true]){
    const f=setup(),files=new Map(),writes=[];const ctx={scope_id:f.scopeId,audience:'sales',issuer_user_id:f.actor,
      original_salesperson_user_id:f.actor,client_id:null,billing_owner_user_id:null};
    const db={from(table){assert.equal(table,'membership_v2_issued_documents');return {select(columns){const filters={};
      const q={eq(k,v){filters[k]=v;return q;},async maybeSingle(){const where=Object.entries(filters).map(([k,v])=>`${k}=${literal(v)}`).join(' and ');
        return {data:JSON.parse(sql(`set role service_role;select row_to_json(t) from (select ${columns} from ${table} where ${where}) t;`)),error:null};}};return q;}};},
      async rpc(name,p){writes.push(name);const r=JSON.parse(sql(`set role service_role;${rpc(name,p.p_document)}`));
        return unknown?{error:{code:'NETWORK',message:'synthetic lost response'}}:{data:[r],error:null};}};
    const service=createMembershipIssuedDocumentService({db,authorizeScope:async()=>ctx,
      loadSource:async()=>({source:f.source,source_fingerprint:f.sourceFingerprint,email_verified:true,
        verified_at:sql(`select verified_at from membership_v2_sales_email_proofs where source_id='${f.sourceId}';`),signing_enabled:false,checkout_enabled:false}),
      loadQuote:async()=>({quote:f.quote,quote_digest:f.source.quote_digest,stale:false,expired:false,signing_enabled:false}),
      legalVersion:f.p.legal_version,loadPublishedLegal:async version=>JSON.parse(sql(`select row_to_json(t) from membership_v2_legal_versions t where version=${literal(version)};`)),
      renderIssuedDocument:async input=>({protocol:'retail_issued_artifact_v2',document_id:input.documentId,
        source_fingerprint:input.snapshot.source_fingerprint,quote_digest:input.snapshot.quote_digest,
        legal_version:input.legal.version,template_sha256:input.legal.template_sha256,
        html:'<html>SYNTHETIC adapter SQL fixture only</html>',pdf_bytes:Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n%%EOF')}),
      artifacts:{async putIfAbsent(p,b,o){assert.equal(o.upsert,false);assert.ok(!files.has(p));files.set(p,Buffer.from(b));},async readPrivate(p){return files.get(p);}}});
    const result=await service.issue({accessToken:'synthetic-test',scopeId:f.scopeId},{sourceId:f.sourceId});
    assert.equal(result.persistence,unknown?'recovered_unknown_commit':'verified');assert.equal(result.delivery,'not_configured');
    assert.equal(result.signing_enabled,false);assert.equal(result.checkout_enabled,false);assert.equal(writes.length,1);
    assert.equal(files.size,1);assert.equal(sql(`select count(*) from membership_v2_issued_documents where id='${result.document_id}';`),'1');
  }
});
test('issued snapshot remains usable after draft quote expires; no current catalog repricing',opts,()=>{
  const f=setup();const d=f.issue();moveQuotePast(f);const a=accept(acceptance(f));assert.equal(a.source_id,f.sourceId);
  const stored=JSON.parse(sql(`set role service_role;select row_to_json(t) from membership_v2_issued_documents t where id='${d.id}';`));
  assert.deepEqual(stored,d);assert.deepEqual(stored.quote_snapshot.offer,f.quote.offer);
});
test('expired native signing deadline holds new acceptance, preserves prior accepted replay',opts,()=>{
  const f=setup();f.issue();sql(`alter table membership_v2_issued_documents disable trigger membership_v2_issued_documents_immutable;
    update membership_v2_issued_documents set issued_at=issued_at-interval '2 days',expires_at=membership_v2_signing_deadline(issued_at-interval '2 days') where id='${f.p.id}';
    alter table membership_v2_issued_documents enable trigger membership_v2_issued_documents_immutable;`);
  denied(`set role service_role;${rpc('membership_v2_accept_document',acceptance(f))}`,/document_acceptance_denied/);
  const g=setup();g.issue();const p=acceptance(g),a=accept(p);
  sql(`alter table membership_v2_issued_documents disable trigger membership_v2_issued_documents_immutable;
    update membership_v2_issued_documents set issued_at=issued_at-interval '2 days',expires_at=membership_v2_signing_deadline(issued_at-interval '2 days') where id='${g.p.id}';
    alter table membership_v2_issued_documents enable trigger membership_v2_issued_documents_immutable;`);
  assert.deepEqual(accept(p),a); // Historical same-attempt replay is NOT new signing authority.
});
test('legal revocation denies new signing; inactive rep denies issuance but not an issued buyer window',opts,()=>{
  const f=setup();f.issue();sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${f.p.legal_version}','Synthetic hold');`);
  denied(`set role service_role;${rpc('membership_v2_accept_document',acceptance(f))}`,/document_acceptance_denied/);
  const g=setup();g.issue();const h=setup();sql(`update sales_reps set active=false where user_id='${rep}';`);
  try{assert.equal(accept(acceptance(g)).source_id,g.sourceId);
    denied(`set role service_role;${rpc('membership_v2_issue_document',h.p)}`,/issued_document_denied/);}
  finally{sql(`update sales_reps set active=true where user_id='${rep}';`);}
});
test('populated new tables have RLS/browser revokes/invoker functions and immutable owner protection',opts,()=>{
  const f=setup();f.issue();accept(acceptance(f));
  for(const t of ['membership_v2_legal_versions','membership_v2_legal_revocations','membership_v2_issued_documents','membership_v2_document_acceptances']){
    assert.equal(sql(`select relrowsecurity from pg_class where oid='${t}'::regclass;`),'t');
    for(const role of ['anon','authenticated'])for(const privilege of ['select','insert','update','delete','truncate'])
      assert.equal(sql(`select has_table_privilege('${role}','${t}','${privilege}');`),'f');
    denied(`set role authenticated;select * from ${t};`,/permission denied/);
    denied(`truncate ${t} cascade;`,/immutable/);
  }
  denied(`update membership_v2_issued_documents set rendered_html=rendered_html where id='${f.p.id}';`,/immutable/);
  denied(`delete from membership_v2_document_acceptances where document_id='${f.p.id}';`,/immutable/);
  assert.equal(sql(`select bool_and(not prosecdef and proconfig is not null) from pg_proc where proname in
    ('membership_v2_issue_document','membership_v2_accept_document','membership_v2_guard_issued_document','membership_v2_guard_document_acceptance');`),'t');
  denied(`set role anon;${rpc('membership_v2_accept_document',acceptance(f))}`,/permission denied/);
});
test('parent grants/constraints/legacy rows remain identical; no Auth/client/contract/payment grant',opts,()=>{
  assert.equal(parents(),baseline);assert.equal(sql('select count(*) from auth.users;'),'2');
  assert.equal(sql('select count(*) from membership_v2_contracts;'),'0');
});
