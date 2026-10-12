'use strict';
// Actual native PG17 on an isolated synthetic Unix-socket instance, never hosted.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const enabled=process.env.ENTERPRISE_EXECUTION_DISPOSABLE==='true',opts={skip:!enabled},socket=process.env.PGHOST||'',port='55444';
const bin='/opt/homebrew/opt/postgresql@17/bin/',database=`enterprise_execution_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const migration='20261012151142_enterprise_execution_seals.sql',client='10000000-0000-4000-8000-000000000001';
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
 typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return cp.spawnSync(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re=/enterprise_execution/){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function apply(n){sql(fs.readFileSync(path.join(root,n),'utf8'));}
function row(id){return JSON.parse(sql(`select row_to_json(a) from membership_agreements a where id='${id}'`));}
function source({marked=true,target=client}={}){
 const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
 const values=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500});
 if(!marked){delete values.pool_offer_snapshot;delete values.pool_offer_digest;}
 const snapshot={values,rendered_html:'SYNTHETIC NATIVE ONLY'};
 sql(`set role service_role;insert into membership_agreements(id,client_id,status,client_legal_name,primary_admin_name,admin_email,membership_tier,
  initial_term_start,initial_renewal_date,billing_option,template_snapshot,signer_token_hash,signer_token_expires_at,agreement_expires_at,draft_pdf_path)
 values('${id}',${lit(target)},'draft','SYNTHETIC ONLY','SYNTHETIC OWNER','synthetic@example.invalid','enterprise',current_date,current_date+365,
 'monthly',${lit(snapshot)},'${token}',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day','synthetic/${id}/preview.pdf');
 update membership_agreements set status='sent' where id='${id}';`);
 return {id,token,snapshot};
}
function seal(s,patch={}){
 const attempt=crypto.randomUUID(),prefix=`enterprise-v2/${s.id}/attempts/${attempt}/`;
 // Negative replay/backfill fixtures also need a syntactically fresh timestamp;
 // a separate test exercises the authenticated native preparation clock.
 const signed=sql(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
 return {agreement_id:s.id,attempt_id:attempt,token_hash:s.token,source_snapshot:s.snapshot,execution:{version:'enterprise_execution_v2',attempt_id:attempt,
  signed_at:signed,signer_typed_name:'SYNTHETIC OWNER',signer_accepted:true,signature_sha256:'a'.repeat(64),signature_size:100,
  signature_image_path:prefix+'signature.png',pixels_sha256:'b'.repeat(64),width:10,height:10,encoding:'png_rgba_v1',
  executed_pdf_path:prefix+'executed.pdf',executed_pdf_sha256:'c'.repeat(64),executed_pdf_size:1000,signer_ip:null,signer_user_agent:'SYNTHETIC',...patch}};
}
function insert(p){return `insert into enterprise_v2_execution_seals(${Object.keys(p).join(',')}) values(${Object.values(p).map(lit).join(',')});`;}
function oldSign(s){return `select id from complete_membership_agreement_signing('${s.id}',clock_timestamp(),null,'SYNTHETIC OWNER',
 'synthetic/signature.png','${'a'.repeat(64)}',null,null,'synthetic/executed.pdf',${lit({...s.snapshot,execution:{legacy:true}})});`;}
function asyncSql(q){return new Promise((resolve,reject)=>{const child=cp.spawn(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q]);
 let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});}
let oldMarked,oldState,legacy,legacyState,malformed;
before(()=>{if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-execution-pg\.[A-Za-z0-9]+$/);
 const r=cp.spawnSync(`${bin}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 grant usage on schema public to service_role,anon,authenticated;create table clients(id uuid primary key);insert into clients values('${client}');
 grant select,update on clients to service_role;`);
 for(const n of ['20260418130000_membership_agreements.sql','20260418170000_membership_agreements_signing_pass2.sql',
  '20260420102000_membership_agreements_current_model.sql','20260422113000_membership_agreements_checkout_state.sql',
  '20260427112000_membership_agreement_voided_status.sql','20261009180000_client_interview_pools.sql'])apply(n);
 sql(`alter table membership_agreements add column agreement_expires_at timestamptz;
 alter table membership_agreements enable row level security;grant select,insert,update,delete on membership_agreements to service_role;`);
 malformed=source({marked:false,target:null});sql(`set role service_role;update membership_agreements set
 template_snapshot=jsonb_set(template_snapshot,'{values,pool_offer_snapshot}','false') where id='${malformed.id}'`);
 apply('20261012032211_enterprise_pool_offer_snapshots.sql');apply('20261012051946_enterprise_pool_source_immutability.sql');
 legacy=source({marked:false,target:null});sql(`set role service_role;${oldSign(legacy)}`);legacyState=row(legacy.id);
 oldMarked=source({target:null});sql(`set role service_role;${oldSign(oldMarked)}`);oldState=row(oldMarked.id);
 apply(migration);
});
after(()=>{if(!enabled)return;const r=cp.spawnSync(`${bin}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
test('migration/replay leave full old signed sources identical, without fabricated seals',opts,()=>{
 assert.deepEqual(row(legacy.id),legacyState);assert.deepEqual(row(oldMarked.id),oldState);apply(migration);
 assert.deepEqual(row(legacy.id),legacyState);assert.deepEqual(row(oldMarked.id),oldState);assert.equal(sql('select count(*) from enterprise_v2_execution_seals'),'0');
});
test('actual native insert atomically signs source and freezes PDF/PNG/pixel evidence',opts,()=>{
 const s=source(),p=seal(s);p.execution.signed_at=sql(`set role service_role;select enterprise_v2_execution_clock('${s.id}','${s.token}')`);
 sql(`set role service_role;${insert(p)}`);const a=row(s.id);
 assert.equal(a.status,'signed');assert.equal(a.is_current,true);assert.equal(a.signer_accepted,true);assert.deepEqual(a.template_snapshot,{...s.snapshot,execution:p.execution});
 assert.equal(sql(`select execution->>'executed_pdf_sha256' from enterprise_v2_execution_seals where agreement_id='${s.id}'`),'c'.repeat(64));
 denied(`set role service_role;${insert(seal(s))}`);assert.deepEqual(row(s.id),a);
});
test('native preparation clock is UTC milliseconds and denies wrong token, expired token and signed source',opts,()=>{
 const s=source();const time=sql(`set role service_role;set timezone='Pacific/Honolulu';select enterprise_v2_execution_clock('${s.id}','${s.token}')`);
 assert.match(time,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);assert.ok(Math.abs(Date.now()-Date.parse(time))<5000);
 denied(`set role service_role;select enterprise_v2_execution_clock('${s.id}','${'b'.repeat(64)}')`);
 sql(`set role service_role;${insert(seal(s))}`);denied(`set role service_role;select enterprise_v2_execution_clock('${s.id}','${s.token}')`);
});
test('actual native classifier has three outcomes; malformed OLD cannot use old RPC or direct update to sign',opts,()=>{
 const s=source(),l=source({marked:false});
 for(const [item,label] of [[s,'marked'],[l,'unmarked'],[malformed,'malformed']]){
  assert.equal(sql(`set role service_role;select enterprise_v2_classify_signing_source('${item.id}','${item.token}')`),label);
 }
 denied(`set role service_role;${oldSign(malformed)}`,/enterprise_execution|enterprise_pool_v2_agreement/);denied(`set role service_role;update membership_agreements set
 status='signed',signed_at=clock_timestamp(),template_snapshot=template_snapshot-'execution' where id='${malformed.id}'`,/enterprise_execution|enterprise_pool_v2_agreement/);
 denied(`set role service_role;select enterprise_v2_execution_clock('${malformed.id}','${malformed.token}')`);
 const before=row(malformed.id);assert.equal(before.status,'sent');assert.equal(before.signed_at,null);
});
test('unsealed old RPC and direct UPDATE cannot sign new marked sources; legacy RPC remains unchanged',opts,()=>{
 const s=source(),before=row(s.id);denied(`set role service_role;${oldSign(s)}`,/seal_required/);
 denied(`set role service_role;update membership_agreements set status='signed',signed_at=clock_timestamp() where id='${s.id}'`,/seal_required/);
 assert.deepEqual(row(s.id),before);const l=source({marked:false});sql(`set role service_role;${oldSign(l)}`);assert.equal(row(l.id).status,'signed');
});
test('cannot backfill old signed marked source; old void/current operational updates preserve its evidence',opts,()=>{
 denied(`set role service_role;${insert(seal(oldMarked))}`);sql(`set role service_role;update membership_agreements set status='voided',is_current=false where id='${oldMarked.id}'`);
 const a=row(oldMarked.id);assert.equal(a.status,'voided');assert.deepEqual(a.template_snapshot,oldState.template_snapshot);
});
for(const patch of [{signer_accepted:'true'},{signer_accepted:false},{version:'legacy'},{attempt_id:crypto.randomUUID()},{signature_sha256:'bad'},
 {executed_pdf_sha256:'bad'},{pixels_sha256:'bad'},{signature_size:56},{signature_size:2097153},{signature_size:'100'},
 {executed_pdf_size:12582913},{executed_pdf_size:0},{width:2049},{height:1025},{width:2048,height:1024},{encoding:'jpeg'},
 {signed_at:'2020-01-01T00:00:00Z'},{signed_at:'2099-01-01T00:00:00Z'},{signed_at:'bad'},
 {signer_typed_name:''},{signer_typed_name:'<bad>'},{signer_ip:{}},{signature_image_path:'legacy/signature.png'},{executed_pdf_path:'legacy/executed.pdf'}]){
 test(`native invalid seal ${JSON.stringify(patch)} rolls back all source/current changes`,opts,()=>{
  const s=source(),before=row(s.id);denied(`set role service_role;${insert(seal(s,patch))}`);assert.deepEqual(row(s.id),before);
  assert.equal(sql(`select count(*) from enterprise_v2_execution_seals where agreement_id='${s.id}'`),'0');
 });
}
test('token rotation/deadline/source mutation deny, and nullable new-prospect client can sign without creating accounts',opts,()=>{
 for(const change of ["signer_token_hash=repeat('b',64)","signer_token_expires_at=clock_timestamp()-interval '1 second'","status='voided'"]){
  const s=source(),p=seal(s);sql(`set role service_role;update membership_agreements set ${change} where id='${s.id}'`);
  const before=row(s.id);denied(`set role service_role;${insert(p)}`);assert.deepEqual(row(s.id),before);
 }
 const s=source(),p=seal(s);p.source_snapshot={...p.source_snapshot,unknown:true};denied(`set role service_role;${insert(p)}`);
 const prospect=source({target:null});sql(`set role service_role;${insert(seal(prospect))}`);assert.equal(row(prospect.id).client_id,null);
});
test('RLS/ACL deny all anonymous/authenticated operations; seal mutation denied even privileged native writes',opts,()=>{
 const s=source(),p=seal(s);for(const role of ['anon','authenticated'])for(const q of ['select * from enterprise_v2_execution_seals',insert(p),
  'update enterprise_v2_execution_seals set token_hash=token_hash','delete from enterprise_v2_execution_seals'])denied(`set role ${role};${q}`,/permission denied/);
 sql(`set role service_role;${insert(p)}`);denied(`update enterprise_v2_execution_seals set token_hash=repeat('b',64) where agreement_id='${s.id}'`,/immutable/);
 denied(`delete from enterprise_v2_execution_seals where agreement_id='${s.id}'`,/immutable/);
 assert.equal(sql("select relrowsecurity from pg_class where oid='enterprise_v2_execution_seals'::regclass"),'t');
 assert.equal(sql("select count(*) from pg_proc where proname like 'enterprise_v2_execution%' and prosecdef"),'0');
});
test('prospective sibling calls serialize without deadlock; supersession preserves both winning seals',opts,async()=>{
 const first=source(),second=source(),a=seal(first),b=seal(second);
 const results=await Promise.all([asyncSql(`set role service_role;${insert(a)}`),asyncSql(`set role service_role;${insert(b)}`)]);
 for(const r of results)assert.equal(r.code,0,r.err);
 const rows=[row(first.id),row(second.id)];assert.deepEqual(rows.map(r=>r.status).sort(),['signed','superseded']);
 assert.equal(rows.filter(r=>r.is_current).length,1);assert.deepEqual(rows[0].template_snapshot.execution,a.execution);assert.deepEqual(rows[1].template_snapshot.execution,b.execution);
});
test('same source simultaneous attempts commit exactly one seal with matching winning source',opts,async()=>{
 const s=source(),a=seal(s),b=seal(s);const results=await Promise.all([asyncSql(`set role service_role;${insert(a)}`),asyncSql(`set role service_role;${insert(b)}`)]);
 assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);const e=JSON.parse(sql(`select execution from enterprise_v2_execution_seals where agreement_id='${s.id}'`));
 assert.deepEqual(row(s.id).template_snapshot.execution,e);assert.ok([a.attempt_id,b.attempt_id].includes(e.attempt_id));
 assert.equal(sql(`select count(*) from enterprise_v2_execution_seals where agreement_id='${s.id}'`),'1');
});
test('AFTER INSERT signing failure rolls seal, signed row and previous-current supersession back together',opts,()=>{
 const previous=source(),p=seal(previous);sql(`set role service_role;${insert(p)}`);const before=row(previous.id),s=source(),initial=row(s.id);
 denied(`begin;create function public.synthetic_execution_failure() returns trigger language plpgsql as $$begin
 if new.id='${s.id}'::uuid and new.status='signed' then raise exception 'SYNTHETIC signing failure';end if;return new;end$$;
 create trigger synthetic_execution_failure after update on membership_agreements for each row execute function public.synthetic_execution_failure();
 set role service_role;${insert(seal(s))}`,/SYNTHETIC signing failure/);
 assert.deepEqual(row(previous.id),before);assert.deepEqual(row(s.id),initial);
 assert.equal(sql(`select count(*) from enterprise_v2_execution_seals where agreement_id='${s.id}'`),'0');
});
