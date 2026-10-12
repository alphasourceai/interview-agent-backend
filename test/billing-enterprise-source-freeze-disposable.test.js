'use strict';
// Opt-in native PG17, private local Unix socket and synthetic rows only.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const enabled=process.env.ENTERPRISE_SOURCE_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port='55442',bin='/opt/homebrew/opt/postgresql@17/bin/';
const database=`alphascreen_enterprise_source_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const migration='20261012051946_enterprise_pool_source_immutability.sql';
const client='10000000-0000-4000-8000-000000000001';
let legacy,baseline,grants;
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`
  :typeof v==='boolean'?String(v):typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return spawnSync(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function apply(name=migration){sql(fs.readFileSync(path.join(root,name),'utf8'));}
function permissions(){return sql(`select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
 from pg_class where oid in('clients'::regclass,'membership_agreements'::regclass,'client_interview_pools'::regclass);`);}
function state(id){return JSON.parse(sql(`select row_to_json(t) from membership_agreements t where id='${id}';`));}
function makeAgreement({marked=true,overrides={}}={}){
 const id=crypto.randomUUID();
 const values={...prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500}),
  platform_fee:100,per_role_fee:0,included_interviews_per_role:0,additional_interview_fee:0,
  max_interview_minutes:15,scored_question_count:6,rollover_days:null};
 if(!marked){delete values.pool_offer_snapshot;delete values.pool_offer_digest;}
 const row={id,client_id:client,status:'draft',client_legal_name:'SYNTHETIC Enterprise',dba_trade_name:'SYNTHETIC ONLY',
  primary_admin_name:'Synthetic Owner',admin_email:'synthetic@example.invalid',membership_tier:'enterprise',
  initial_term_start:'2026-10-12',initial_renewal_date:'2027-10-12',billing_option:'monthly',auto_renew:true,
  notice_deadline_days:30,template_version:'synthetic-old-legal-version',draft_pdf_path:`synthetic/${id}/draft.pdf`,
  signer_token_hash:crypto.randomBytes(32).toString('hex'),signer_token_expires_at:'2026-11-12T00:00:00Z',
  agreement_expires_at:'2026-11-12T00:00:00Z',created_by_email:'synthetic@example.invalid',
  template_snapshot:{values,generated_at:'2026-10-12T00:00:00Z',legal:{text:'SYNTHETIC legal wording; not an executed contract'}},...overrides};
 sql(`set role service_role;insert into membership_agreements(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')});`);
 return id;
}
function signingStatement(id,snapshot){return `select id,status from complete_membership_agreement_signing('${id}','2026-10-12T05:00:00Z','2026-10-12T04:00:00Z',
 'SYNTHETIC signer','synthetic/${id}/signature.png','${'a'.repeat(64)}','192.0.2.1','SYNTHETIC test agent',
 'synthetic/${id}/executed.pdf',${lit(snapshot)});`;}
function sign(id){const snapshot={...state(id).template_snapshot,execution:{signed_at:'2026-10-12T05:00:00Z',synthetic:true}};
 sql(`set role service_role;update membership_agreements set status='sent',sent_at='2026-10-12T03:00:00Z' where id='${id}';${signingStatement(id,snapshot)}`);
 return state(id);
}
before(()=>{
 if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-source-pg\.[A-Za-z0-9]+$/);
 const r=spawnSync(`${bin}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
  grant usage on schema public to anon,authenticated,service_role;
  create table clients(id uuid primary key,name text);insert into clients values('${client}','SYNTHETIC ONLY');`);
 for(const name of ['20260418130000_membership_agreements.sql','20260418170000_membership_agreements_signing_pass2.sql',
  '20260420102000_membership_agreements_current_model.sql','20260422113000_membership_agreements_checkout_state.sql',
  '20260427112000_membership_agreement_voided_status.sql','20261009180000_client_interview_pools.sql'])apply(name);
 // This column is from the sales-completion migration; unrelated sales tables
 // are outside this native fixture. No hosted schema is asserted by this test.
 sql(`alter table membership_agreements add column agreement_expires_at timestamptz;
  alter table membership_agreements enable row level security;
  grant select,insert,update,delete on clients,membership_agreements to service_role;`);
 legacy=makeAgreement({marked:false});sign(legacy);baseline=state(legacy);grants=permissions();
 apply('20261012032211_enterprise_pool_offer_snapshots.sql');
 // Reproduce the precise predecessor gap against native PostgreSQL, then
 // rollback the reprice and remove only this newly authored synthetic probe.
 const probe=makeAgreement();
 const repriced=sql(`set role service_role;begin;update membership_agreements set
  template_snapshot=jsonb_set(template_snapshot,'{values,platform_fee}','999') where id='${probe}';
  select template_snapshot->'values'->>'platform_fee' from membership_agreements where id='${probe}';rollback;`);
 assert.equal(repriced,'999');assert.equal(state(probe).template_snapshot.values.platform_fee,100);
 sql(`set role service_role;delete from membership_agreements where id='${probe}';`);
 console.log('PREDECESSOR native gap confirmed: platform_fee changed with identical pool digest; probe rolled back/removed.');
 apply();
});
after(()=>{if(!enabled)return;const r=spawnSync(`${bin}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});

test('additive migration/replay preserves complete legacy row, ACL and RLS',opts,()=>{
 assert.deepEqual(state(legacy),baseline);assert.equal(permissions(),grants);apply();
 assert.deepEqual(state(legacy),baseline);assert.equal(permissions(),grants);
});
for(const [field,value] of Object.entries({platform_fee:999,per_role_fee:999,included_interviews_per_role:99,
 additional_interview_fee:999,max_interview_minutes:60,scored_question_count:1,rollover_days:90})){
 test(`actual native draft prevents ${field} repricing while same pool digest survives`,opts,()=>{
  const id=makeAgreement(),old=state(id),snapshot=structuredClone(old.template_snapshot);snapshot.values[field]=value;
  denied(`set role service_role;update membership_agreements set template_snapshot=${lit(snapshot)} where id='${id}';`,/source_immutable/);
  assert.deepEqual(state(id),old);
 });
}
test('all non-execution snapshot keys, including legal text, version and generated clock, are frozen',opts,()=>{
 const id=makeAgreement(),old=state(id);
 for(const patch of [{legal:{text:'changed'}},{generated_at:'2026-12-01Z'},{unknown:'new-key'},
  {values:{...old.template_snapshot.values,extra:'changed'}},{values:null}]){
  denied(`set role service_role;update membership_agreements set template_snapshot=${lit({...old.template_snapshot,...patch})} where id='${id}';`,/source_immutable|agreement_immutable|agreement_denied|backfill_denied/);
 }
 assert.deepEqual(state(id),old);
});
test('nullable frozen native columns reject value-to-NULL and NULL-to-value transitions',opts,()=>{
 const changes={dba_trade_name:'SYNTHETIC trade',created_by_email:'synthetic@example.invalid',
  created_by_user_id:'20000000-0000-4000-8000-000000000003',agreement_expires_at:'2026-11-12T00:00:00Z'};
 for(const [field,value] of Object.entries(changes)){
  const present=makeAgreement({overrides:{[field]:value}}),absent=makeAgreement({overrides:{[field]:null}});
  for(const [id,next] of [[present,null],[absent,value]]){
   const old=state(id);denied(`set role service_role;update membership_agreements set ${field}=${lit(next)} where id='${id}';`,/source_immutable/);
   assert.deepEqual(state(id),old);
  }
 }
});
test('execution combined with any named commercial snapshot edit is denied before AND after signing',opts,()=>{
 for(const signed of [false,true]){
  const id=makeAgreement();if(signed)sign(id);const old=state(id);
  for(const [field,value] of Object.entries({platform_fee:999,per_role_fee:999,included_interviews_per_role:99,
   additional_interview_fee:999,max_interview_minutes:60,scored_question_count:1,rollover_days:90})){
   const snapshot=structuredClone(old.template_snapshot);snapshot.execution={changed:true};snapshot.values[field]=value;
   denied(`set role service_role;update membership_agreements set template_snapshot=${lit(snapshot)} where id='${id}';`,/source_immutable/);
   assert.deepEqual(state(id),old);
  }
 }
});
for(const [field,value] of Object.entries({id:'20000000-0000-4000-8000-000000000001',client_id:'20000000-0000-4000-8000-000000000002',
 client_legal_name:'changed',dba_trade_name:'changed',primary_admin_name:'changed',admin_email:'changed@example.invalid',
 initial_term_start:'2026-11-12',initial_renewal_date:'2028-11-12',billing_option:'annual',auto_renew:false,
 notice_deadline_days:5,template_version:'changed',draft_pdf_path:'changed.pdf',created_by_user_id:'20000000-0000-4000-8000-000000000003',
 created_by_email:'changed@example.invalid',created_at:'2026-01-01Z',agreement_expires_at:'2026-12-01Z'})){
 test(`native original ${field} frozen before signing`,opts,()=>{
  const id=makeAgreement(),old=state(id);
  denied(`set role service_role;update membership_agreements set ${field}=${lit(value)} where id='${id}';`,/immutable/);
  assert.deepEqual(state(id),old);
 });
}
test('actual native signing RPC appends execution and supersedes both legacy and marked sources',opts,()=>{
 // Other tests may sign their own sources. Make this legacy predecessor current
 // immediately before this scenario rather than relying on shared suite state.
 const priorLegacy=makeAgreement({marked:false}),priorState=sign(priorLegacy);
 const first=makeAgreement(),a=sign(first),old=state(priorLegacy);
 assert.equal(a.status,'signed');assert.equal(a.is_current,true);assert.equal(a.signer_accepted,true);
 assert.equal(old.status,'superseded');assert.equal(old.is_current,false);
 assert.equal(old.superseded_by_agreement_id,first);assert.deepEqual(old.template_snapshot,priorState.template_snapshot);
 const second=makeAgreement(),b=sign(second),superseded=state(first);
 assert.equal(b.status,'signed');assert.equal(b.is_current,true);
 assert.equal(superseded.status,'superseded');assert.equal(superseded.is_current,false);
 assert.equal(superseded.superseded_by_agreement_id,second);
 for(const key of ['signed_at','signer_typed_name','signature_sha256','executed_pdf_path','template_snapshot'])assert.deepEqual(superseded[key],a[key]);
});
test('forged reprice passed to actual signing RPC fails and rolls back previous-current supersession',opts,()=>{
 const previous=makeAgreement();sign(previous);const before=state(previous),id=makeAgreement();
 const snapshot=state(id).template_snapshot;snapshot.values.platform_fee=777;
 sql(`set role service_role;update membership_agreements set status='sent' where id='${id}';`);
 denied(`set role service_role;${signingStatement(id,snapshot)}`,/source_immutable/);
 assert.deepEqual(state(previous),before);assert.equal(state(id).status,'sent');assert.equal(state(id).signed_at,null);
});
for(const [field,value] of Object.entries({signed_at:'2026-11-01Z',signer_typed_name:'changed',signer_accepted:false,
 signature_image_path:'changed.png',signature_sha256:'b'.repeat(64),signer_ip:'192.0.2.2',signer_user_agent:'changed',executed_pdf_path:'changed.pdf'})){
 test(`signed native ${field} cannot change`,opts,()=>{
  const id=makeAgreement(),old=sign(id);
  denied(`set role service_role;update membership_agreements set ${field}=${lit(value)} where id='${id}';`,/signed_source_immutable/);
  assert.deepEqual(state(id),old);
 });
}
test('signed execution removal/edit, term changes, source deletion and regression to draft/sent are denied',opts,()=>{
 const id=makeAgreement(),old=sign(id);
 for(const statement of ["template_snapshot=template_snapshot-'execution'","template_snapshot=jsonb_set(template_snapshot,'{execution}', '{}')",
  "initial_renewal_date='2028-01-01'","status='draft'","status='sent'"])
  denied(`set role service_role;update membership_agreements set ${statement} where id='${id}';`,/immutable/);
 denied(`set role service_role;delete from membership_agreements where id='${id}';`,/source_delete_denied/);
 assert.deepEqual(state(id),old);
 const draft=makeAgreement();denied(`set role service_role;delete from membership_agreements where id='${draft}';`,/source_delete_denied/);
});
test('signed nullable native evidence rejects NULL in both directions using OLD signed-state predicate',opts,()=>{
 const id=makeAgreement(),old=sign(id);
 for(const field of ['signed_at','signer_typed_name','signer_accepted','signature_image_path','signature_sha256',
  'signer_ip','signer_user_agent','executed_pdf_path']){
  denied(`set role service_role;update membership_agreements set ${field}=null where id='${id}';`,/signed_source_immutable/);
  assert.deepEqual(state(id),old);
 }
 // An actual nullable native signing-RPC input, not a fabricated browser proof.
 const missingIp=makeAgreement();const snapshot={...state(missingIp).template_snapshot,execution:{synthetic:true}};
 sql(`set role service_role;update membership_agreements set status='sent' where id='${missingIp}';
  select id from complete_membership_agreement_signing('${missingIp}','2026-10-12T05:00:00Z',null,'SYNTHETIC signer',
  'synthetic/signature.png','${'a'.repeat(64)}',null,null,'synthetic/executed.pdf',${lit(snapshot)});`);
 for(const field of ['signer_ip','signer_user_agent'])denied(`set role service_role;update membership_agreements set ${field}='changed' where id='${missingIp}';`,/signed_source_immutable/);
});
test('operational delivery/signing/current/void/checkout updates retain existing behavior',opts,()=>{
 const id=makeAgreement();sql(`set role service_role;update membership_agreements set signer_token_hash='${crypto.randomBytes(32).toString('hex')}',
 signer_token_expires_at='2026-12-01Z',opened_at='2026-10-12Z',updated_at='2026-10-12Z' where id='${id}';`);
 const old=sign(id);sql(`set role service_role;update membership_agreements set signer_token_hash='${crypto.randomBytes(32).toString('hex')}',
 signer_token_expires_at='2026-12-01Z',sent_at='2026-10-13Z',opened_at='2026-10-13Z',
 checkout_status='pending_payment',checkout_session_id='cs_SYNTHETIC',
 checkout_created_at='2026-10-12Z',updated_at='2026-10-13Z' where id='${id}';
 update membership_agreements set checkout_status='paid',checkout_paid_at='2026-10-14Z',status='voided',is_current=false,
 voided_at='2026-10-14Z',voided_by_email='synthetic@example.invalid',void_reason='Synthetic operational test, not payment proof' where id='${id}';`);
 const changed=state(id);assert.equal(changed.checkout_status,'paid');assert.equal(changed.status,'voided');
 assert.deepEqual(changed.template_snapshot,old.template_snapshot);assert.equal(changed.signed_at,old.signed_at);
 denied(`set role service_role;update membership_agreements set signed_at=null where id='${id}';`,/signed_source_immutable/);
 // This test proves legacy bookkeeping compatibility, NOT genuine activation.
});
test('native marked source restores prior superseded current row after void without rewriting evidence',opts,()=>{
 const first=makeAgreement(),a=sign(first),second=makeAgreement();sign(second);
 sql(`set role service_role;update membership_agreements set status='voided',is_current=false,voided_at='2026-10-13Z' where id='${second}';
  update membership_agreements set status='signed',is_current=true,superseded_at=null,superseded_by_agreement_id=null,updated_at='2026-10-13Z' where id='${first}';`);
 const restored=state(first);assert.equal(restored.status,'signed');assert.equal(restored.is_current,true);
 assert.equal(restored.signed_at,a.signed_at);assert.deepEqual(restored.template_snapshot,a.template_snapshot);
});
test('actual legacy activation date rewrite is held for marked source, not interpreted as new v2 activation',opts,()=>{
 const id=makeAgreement(),old=sign(id);
 denied(`set role service_role;update membership_agreements set initial_term_start='2026-11-01',initial_renewal_date='2027-11-01',
  checkout_status='paid',checkout_paid_at='2026-11-01Z' where id='${id}';`,/source_immutable/);
 assert.deepEqual(state(id),old);
});
test('legacy rows retain prior mutability and removability without v2 backfill',opts,()=>{
 const id=makeAgreement({marked:false});sign(id);
 sql(`set role service_role;update membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{values,platform_fee}','999'),
 primary_admin_name='legacy changed',signed_at='2026-11-01Z' where id='${id}';`);
 assert.equal(state(id).template_snapshot.values.platform_fee,999);
 sql(`set role service_role;delete from membership_agreements where id='${id}';`);
 assert.equal(sql(`select count(*) from membership_agreements where id='${id}';`),'0');
 const nullMarked=makeAgreement({marked:false});
 // Missing marker and explicit JSON-null marker are both genuinely unmarked.
 sql(`set role service_role;update membership_agreements set template_snapshot=jsonb_set(jsonb_set(template_snapshot,
  '{values,pool_offer_snapshot}','null'),'{values,pool_offer_digest}','null') where id='${nullMarked}';
  update membership_agreements set primary_admin_name='JSON null marker changed' where id='${nullMarked}';
  delete from membership_agreements where id='${nullMarked}';`);
});
test('marked NULL pending state rejected by trigger even on nullable local fixture; legacy remains unchanged',opts,()=>{
 sql('alter table client_interview_pools alter column status drop not null;');
 const p=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500}),s=p.pool_offer_snapshot;
 const row={client_id:client,quantity_purchased:s.quantity,unit_price_cents:s.unit_price_cents,discount_pct:s.automatic_discount_percent,
 total_cents:s.net_cents,offer_snapshot:s,offer_digest:p.pool_offer_digest,status:null};
 denied(`set role service_role;insert into client_interview_pools(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')});`,/pending_required/);
 const id=crypto.randomUUID();sql(`set role service_role;insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents,status)
 values('${id}','${client}',1,0,0,null);delete from client_interview_pools where id='${id}';`);
 sql('alter table client_interview_pools alter column status set not null;');
 row.status='pending';const pool=crypto.randomUUID();sql(`set role service_role;insert into client_interview_pools(id,${Object.keys(row).join(',')}) values('${pool}',${Object.values(row).map(lit).join(',')});`);
 denied(`set role service_role;update client_interview_pools set status='paid',paid_at=clock_timestamp() where id='${pool}';`,/PAYMENT_PROOF_REQUIRED/);
 for(const status of ['paid','failed','voided','refunded','unknown']){
  row.status=status;denied(`set role service_role;insert into client_interview_pools(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')});`,/pending_required/);
 }
 for(const status of ['pending','paid','failed','voided','refunded']){
  const legacyPool=crypto.randomUUID();sql(`set role service_role;insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents,status)
   values('${legacyPool}','${client}',1,0,0,${lit(status)});`);
  assert.equal(sql(`select status from client_interview_pools where id='${legacyPool}';`),status);
 }
});
test('new native functions invoker-only and browser-denied; original ACL/RLS unchanged',opts,()=>{
 for(const fn of ['enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_pending_insert']){
  assert.equal(sql(`select prosecdef from pg_proc where pronamespace='public'::regnamespace and proname='${fn}';`),'f');
  assert.equal(sql(`select proconfig::text from pg_proc where pronamespace='public'::regnamespace and proname='${fn}';`),'{search_path=pg_catalog}');
  for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.${fn}()','execute');`),'f');
  assert.equal(sql(`select has_function_privilege('service_role','public.${fn}()','execute');`),'t');
 }
 assert.equal(permissions(),grants);
 assert.deepEqual(JSON.parse(sql(`select jsonb_agg(jsonb_build_object('name',tgname,'type',tgtype,'deferrable',tgdeferrable,'constraint',tgconstraint::integer) order by tgname)
  from pg_trigger where tgname in('enterprise_pool_v2_guard_source','enterprise_pool_v2_guard_pending_insert');`)),
  [{name:'enterprise_pool_v2_guard_pending_insert',type:7,deferrable:false,constraint:0},
   {name:'enterprise_pool_v2_guard_source',type:27,deferrable:false,constraint:0}]);
 for(const role of ['anon','authenticated'])denied(`set role ${role};select * from membership_agreements;`,/permission denied/);
});
