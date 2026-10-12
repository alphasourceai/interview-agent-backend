'use strict';
// Actual disposable PostgreSQL, real parent migrations/RPCs. SYNTHETIC HTML,
// PDF/signature hashes and publication descriptor only; not real signed PDFs,
// Supabase Auth/storage, published legal approval or provider acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,spawn}=require('node:child_process'),{test,before,after}=require('node:test');
const {fixture:offerFixture,canonical,sha}=require('./retail-review-fixture');
const {createMembershipIssuedDocumentService}=require('../../src/services/membershipIssuedDocuments');
const enabled=process.env.MEMBERSHIP_V2_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port=process.env.PGPORT||'55440',PG='/opt/homebrew/opt/postgresql@17/bin/';
const database=`alphascreen_retail_signing_${process.pid}`,root=path.join(__dirname,'../../supabase/migrations');
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
    '20261011201754_membership_v2_sales_quote_scopes.sql','20261011211123_membership_v2_sales_prospects.sql',migration,'20261011235321_membership_v2_signing_sessions.sql']){
    if(file===migration)baseline=parents();const result=spawnSync(`${PG}psql`,[...args(),'-f',path.join(root,file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
});
after(()=>{if(!enabled)return;const r=spawnSync(`${PG}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});


module.exports={setup,source,acceptance,accept,sql,run,denied,asyncSQL,blocked,sleeping,literal,rpc,insert,args,opts,rep,other};

