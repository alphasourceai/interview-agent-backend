'use strict';
// Actual local PostgreSQL and real native signing-seal trigger. No Auth/SDK.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const enabled=process.env.ENTERPRISE_PENDING_DISPOSABLE==='true',opts={skip:!enabled},socket=process.env.PGHOST||'',port='55452';
const bin='/opt/homebrew/opt/postgresql@17/bin/',database=`enterprise_pending_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const migration='20261013100736_enterprise_existing_pending_checkout_binding.sql';
const config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
 typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return cp.spawnSync(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re=/enterprise_binding|enterprise_pool|permission denied/){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function apply(n=migration){sql(fs.readFileSync(path.join(root,n),'utf8'));}
const row=s=>JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id='${s.id}'`));
const pool=s=>JSON.parse(sql(`select to_jsonb(p) from client_interview_pools p where agreement_id='${s.id}'`));
function source({cadence='monthly',fees={},signed=true,deadline='1 day',marked=true,parent}={}){
 const id=crypto.randomUUID(),client=parent?.client||crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),customer=parent?.customer||`cus_SYNTHETIC_${client.replaceAll('-','')}`;
 const values=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',billing_option:cadence,platform_fee:'999.99',
  per_role_fee:'0',additional_interview_fee:'0',included_interviews_per_role:'0',pool_quantity:30,usage_interview_fee_cents:2500,
  max_interview_minutes:'20',scored_question_count:'5',...fees});
 if(!marked){delete values.pool_offer_snapshot;delete values.pool_offer_digest;}
 const snapshot={values,rendered_html:'SYNTHETIC ONLY'};
 sql(`set role service_role;${parent?'':`insert into clients(id,stripe_customer_id) values('${client}','${customer}');`}
 insert into membership_agreements(id,client_id,status,client_legal_name,primary_admin_name,admin_email,membership_tier,
 initial_term_start,initial_renewal_date,billing_option,template_snapshot,signer_token_hash,signer_token_expires_at,agreement_expires_at,draft_pdf_path)
 values('${id}','${client}','draft','SYNTHETIC','SYNTHETIC OWNER','owner@example.invalid','enterprise',current_date,current_date+365,
 ${lit(cadence)},${lit(snapshot)},'${token}',clock_timestamp()+interval '1 day',clock_timestamp()+interval '${deadline}','synthetic/${id}/preview.pdf');
 update membership_agreements set status='sent' where id='${id}'`);
 const s={id,client,customer,token,snapshot};
 if(signed){
  if(!marked){sql(`set role service_role;select id from complete_membership_agreement_signing('${id}',clock_timestamp(),null,'SYNTHETIC',
   'synthetic/signature.png','${'a'.repeat(64)}',null,null,'synthetic/executed.pdf',${lit(snapshot)});`);}
  else sql(`set role service_role;${sealSql(s)}`);
 }
 return s;
}
function sealSql(s){const attempt=crypto.randomUUID(),prefix=`enterprise-v2/${s.id}/attempts/${attempt}/`;
 const time=sql(`set role service_role;select enterprise_v2_execution_clock('${s.id}','${s.token}')`),unsigned=s.snapshot;
 const execution={version:'enterprise_execution_v2',attempt_id:attempt,signed_at:time,signer_typed_name:'SYNTHETIC OWNER',signer_accepted:true,
  signature_sha256:'a'.repeat(64),signature_size:100,signature_image_path:prefix+'signature.png',pixels_sha256:'b'.repeat(64),width:10,height:10,
  encoding:'png_rgba_v1',executed_pdf_path:prefix+'executed.pdf',executed_pdf_sha256:'c'.repeat(64),executed_pdf_size:1000,signer_ip:null,signer_user_agent:'SYNTHETIC'};
 s.snapshot={...unsigned,execution};
 return `insert into enterprise_v2_execution_seals(agreement_id,attempt_id,token_hash,source_snapshot,execution,signed_at)
 values('${s.id}','${attempt}','${s.token}',${lit(unsigned)},${lit(execution)},${lit(time)});`;
}
function claim(s,{target=s.client,expected=s.snapshot,customer=s.customer,embedded=false,replacement=null,configuration=config}={}){
 return `select claim_enterprise_existing_pending_checkout(${[s.id,target,expected,customer,embedded,replacement,configuration].map(lit).join(',')});`;
}
const claimed=(s,p)=>JSON.parse(sql(`set role service_role;${claim(s,p)}`));
function asyncSql(q){return new Promise((resolve,reject)=>{const c=cp.spawn(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q]);
 let out='',err='';c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);c.on('error',reject);c.on('close',code=>resolve({code,out,err}));});}
const acl=()=>sql(`select jsonb_agg(jsonb_build_array(relname,relacl::text,relrowsecurity) order by relname) from pg_class
 where oid in('clients'::regclass,'membership_agreements'::regclass,'client_interview_pools'::regclass,'enterprise_v2_execution_seals'::regclass)`);
let legacy,legacyRow,oldPool,oldPoolRow,permissions;
before(()=>{if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-enterprise-pending-pg\.[A-Za-z0-9]+$/);assert.equal(process.env.PGPASSWORD,undefined);
 const r=cp.spawnSync(`${bin}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 grant usage on schema public to service_role,anon,authenticated;
 create table clients(id uuid primary key,stripe_customer_id text,parent_client_id uuid,archived_at timestamptz);
 grant select,insert,update on clients to service_role;alter table clients enable row level security;`);
 for(const n of ['20260418130000_membership_agreements.sql','20260418170000_membership_agreements_signing_pass2.sql',
  '20260420102000_membership_agreements_current_model.sql','20260422113000_membership_agreements_checkout_state.sql',
  '20260425130000_membership_agreement_replacement_fields.sql','20260427112000_membership_agreement_voided_status.sql','20261009180000_client_interview_pools.sql'])apply(n);
 sql(`alter table membership_agreements add column agreement_expires_at timestamptz,add column checkout_attempt_source jsonb,add column checkout_embedded boolean;
 alter table membership_agreements enable row level security;grant select,insert,update,delete on membership_agreements to service_role;
 create table public_purchase_intents(id uuid primary key default gen_random_uuid(),agreement_id uuid);
 grant select,insert on public_purchase_intents to service_role;alter table public_purchase_intents enable row level security;`);
 for(const n of ['20261012032211_enterprise_pool_offer_snapshots.sql','20261012051946_enterprise_pool_source_immutability.sql','20261012151142_enterprise_execution_seals.sql'])apply(n);
 legacy=source({marked:false});legacyRow=row(legacy);oldPool=crypto.randomUUID();
 sql(`set role service_role;insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents,status,paid_at)
 values('${oldPool}','${legacy.client}',10,100,1000,'paid',clock_timestamp());`);
 oldPoolRow=JSON.parse(sql(`select to_jsonb(p) from client_interview_pools p where id='${oldPool}'`));permissions=acl();
 for(const change of ["alter table client_interview_pools disable trigger enterprise_pool_v2_guard_pool",
  "grant select on client_interview_pools to authenticated","alter table enterprise_v2_execution_seals disable row level security",
  "create policy synthetic_unexpected on client_interview_pools for select to authenticated using(true)",
  "create or replace function enterprise_pool_v2_valid_offer(s jsonb) returns boolean language sql as $$select true$$",
  "alter table client_interview_pools drop constraint client_interview_pools_total_check;alter table client_interview_pools add constraint client_interview_pools_total_check check(true)",
  "alter table client_interview_pools alter column offer_digest type varchar",
  "alter table client_interview_pools alter column client_id drop not null"])
  denied(`begin;${change};${fs.readFileSync(path.join(root,migration),'utf8')}`,/enterprise_binding_.*drift/);
 assert.equal(acl(),permissions);apply();
});
after(()=>{if(!enabled)return;const r=cp.spawnSync(`${bin}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
test('migration keeps legacy rows/ACL/RLS and old signing grants; repeat refuses without overwrite',opts,()=>{
 const a=row(legacy);delete a.enterprise_checkout_source;delete a.enterprise_checkout_pool_id;assert.deepEqual(a,legacyRow);
 const p=JSON.parse(sql(`select to_jsonb(p)-'agreement_id' from client_interview_pools p where id='${oldPool}'`));assert.deepEqual(p,oldPoolRow);
 assert.equal(acl(),permissions);denied(fs.readFileSync(path.join(root,migration),'utf8'),/schema_acl_drift/);assert.equal(acl(),permissions);
});
for(const cadence of ['monthly','annual'])for(const embedded of [true,false])test(`real sealed ${cadence}/${embedded} claim yields one frozen pending pool`,opts,()=>{
 const s=source({cadence}),result=claimed(s,{embedded,replacement:'sub_SYNTHETIC'}),a=row(s),p=pool(s);
 assert.equal(a.enterprise_checkout_pool_id,p.id);assert.equal(p.agreement_id,s.id);assert.equal(p.client_id,s.client);assert.equal(result.pool_id,p.id);
 assert.equal(p.status,'pending');assert.equal(p.paid_at,null);assert.equal(p.stripe_payment_intent_id,null);assert.equal(p.stripe_checkout_session_id,null);
 assert.deepEqual(p.offer_snapshot,s.snapshot.values.pool_offer_snapshot);assert.equal(p.offer_digest,s.snapshot.values.pool_offer_digest);
 for(const field of ['checkout_created_at','checkout_session_id','checkout_paid_at','checkout_status','checkout_attempt_source','checkout_embedded','replaces_stripe_subscription_id','replacement_policy'])assert.equal(a[field],null);
 assert.match(result.created_at,/\.\d{3}Z$/);assert.match(result.expires_at,/\.\d{6}Z$/);
 assert.ok(Math.abs(Date.now()-Date.parse(result.created_at))<5000);
 assert.deepEqual(claimed(s,{embedded,replacement:'sub_DIFFERENT'}),result);assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),'1');
});
test('racing claims commit same pool/clock/replacement winner, no second pending row',opts,async()=>{
 const s=source();const r=await Promise.all(['sub_FIRST','sub_SECOND'].map(replacement=>asyncSql(`set role service_role;${claim(s,{replacement})}`)));
 for(const x of r)assert.equal(x.code,0,x.err);const a=JSON.parse(r[0].out),b=JSON.parse(r[1].out);assert.deepEqual(a,b);
 assert.ok(['sub_FIRST','sub_SECOND'].includes(a.replacement_id));assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),'1');
});
test('wrong native source/customer/config/mode and every untracked shared artifact hold without pool creation',opts,()=>{
 for(const settings of [{target:crypto.randomUUID()},{expected:{}},{customer:'cus_OTHER'},{embedded:null},{replacement:'bad'},
  {configuration:{...config,extra:'bad'}},{configuration:{...config,public_sign_base:'http://site.example.invalid'}}]){
  const s=source(),before=row(s);denied(`set role service_role;${claim(s,settings)}`);assert.deepEqual(row(s),before);
  assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),'0');
 }
 for(const change of ["checkout_created_at=clock_timestamp()","checkout_session_id='cs_OLD'","checkout_status='paid'",
  "checkout_paid_at=clock_timestamp()","replaces_stripe_subscription_id='sub_OLD'","checkout_attempt_source='{}'","checkout_embedded=true","replacement_policy='immediate_cancel'"]){
  const s=source();sql(`update membership_agreements set ${change} where id='${s.id}'`);denied(`set role service_role;${claim(s)}`);
  assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),'0');
 }
 const s=source(),x=claimed(s);for(const patch of [{embedded:true},{configuration:{...config,public_backend_base:'https://other.example.invalid'}}])denied(`set role service_role;${claim(s,patch)}`);
 sql(`update clients set stripe_customer_id='cus_CHANGED' where id='${s.client}'`);denied(`set role service_role;${claim(s,{customer:'cus_CHANGED'})}`);assert.deepEqual(row(s).enterprise_checkout_source,x);
});
test('unsigned/legacy/unexpected intent/child/archived/stale/current/expired input cannot create binding',opts,()=>{
 for(const settings of [{signed:false},{marked:false},{deadline:'10 minutes'}]){const s=source(settings);denied(`set role service_role;${claim(s)}`);}
 for(const change of ["status='voided'","is_current=false","superseded_at=clock_timestamp()"]){const s=source();sql(`update membership_agreements set ${change} where id='${s.id}'`);denied(`set role service_role;${claim(s)}`);}
 for(const change of ["parent_client_id=gen_random_uuid()","archived_at=clock_timestamp()"]){const s=source();sql(`update clients set ${change} where id='${s.client}'`);denied(`set role service_role;${claim(s)}`);}
 const s=source();sql(`insert into public_purchase_intents(agreement_id) values('${s.id}')`);denied(`set role service_role;${claim(s)}`);
});
test('invalid custom prices/capacity are held; valid optional capacity remains signed and unchanged',opts,()=>{
 for(const fees of [{platform_fee:'0'},{platform_fee:'1.001'},{per_role_fee:'1'},{additional_interview_fee:'1'},
  {included_interviews_per_role:'1'},{rollover_days:'90'},{max_interview_minutes:'60'},{scored_question_count:'8'},
  {max_interview_minutes:'',scored_question_count:'5'}]){const s=source({fees});denied(`set role service_role;${claim(s)}`);}
 const s=source({fees:{max_interview_minutes:'',scored_question_count:''}});claimed(s);assert.deepEqual(row(s).template_snapshot,s.snapshot);
});
test('native binding, pool ownership and clocks immutable; credits/payment ids remain blocked',opts,()=>{
 const s=source();claimed(s);const a=row(s),p=pool(s);
 for(const change of ["enterprise_checkout_source=null","enterprise_checkout_pool_id=null","enterprise_checkout_source=jsonb_set(enterprise_checkout_source,'{created_at}','\"2020-01-01T00:00:00.000Z\"')",
  "checkout_created_at=clock_timestamp()","checkout_session_id='cs_FORGED'","checkout_status='paid'","checkout_paid_at=clock_timestamp()"])
  denied(`set role service_role;update membership_agreements set ${change} where id='${s.id}'`);
 for(const change of ["agreement_id=null","client_id=gen_random_uuid()","status='paid',paid_at=clock_timestamp()","stripe_checkout_session_id='cs_FORGED'","stripe_payment_intent_id='pi_FORGED'"])
  denied(`set role service_role;update client_interview_pools set ${change} where id='${p.id}'`);
 denied(`delete from membership_agreements where id='${s.id}'`);denied(`delete from client_interview_pools where id='${p.id}'`);
 assert.deepEqual(row(s),a);assert.deepEqual(pool(s),p);assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}' and status='paid'`),'0');
});
test('deferred reciprocal check rejects orphan/wrong-client/new legacy link; both sides rollback on late error',opts,()=>{
 const s=source(),o=s.snapshot.values.pool_offer_snapshot,pid=crypto.randomUUID(),before=row(s);
 const insert=`insert into client_interview_pools(id,client_id,agreement_id,quantity_purchased,unit_price_cents,total_cents,discount_pct,offer_snapshot,offer_digest)
 values('${pid}','${s.client}','${s.id}',${o.quantity},${o.unit_price_cents},${o.net_cents},${o.automatic_discount_percent},${lit(o)},${lit(s.snapshot.values.pool_offer_digest)})`;
 denied(`set role service_role;${insert}`,/pair_denied/);assert.equal(sql(`select count(*) from client_interview_pools where id='${pid}'`),'0');
 denied(`begin;set role service_role;${claim(s)};select 1/0;commit;`,/division by zero/);assert.deepEqual(row(s),before);
 assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),'0');
 denied(`update client_interview_pools set agreement_id='${s.id}' where id='${oldPool}'`,/link_immutable/);
});
test('RLS/ACL deny browser invocation, new functions invoker-only and bounded lock timeout',opts,()=>{
 const s=source();for(const role of ['anon','authenticated'])denied(`set role ${role};${claim(s)}`,/permission denied/);
 denied(claim(s),/claim_denied/);
 assert.equal(sql("select count(*) from pg_proc where proname like 'enterprise_existing_pending_%' and prosecdef"),'0');
 assert.equal(sql("select proconfig::text from pg_proc where proname='claim_enterprise_existing_pending_checkout'"),'{search_path=pg_catalog,lock_timeout=10s}');
 assert.equal(acl(),permissions);
});
test('actual native expiry math caps legal, next UTC first and idempotency window; first-day means following month',opts,()=>{
 const vectors=[['2026-01-13T10:00:00Z','2026-02-10Z','2026-01-14T09:59:59Z'],
  ['2026-01-31T23:15:00Z','2026-02-10Z','2026-01-31T23:59:59Z'],
  ['2026-02-28T23:59:00Z','2026-03-10Z','2026-02-28T23:59:59Z'],
  ['2026-02-01T00:00:00Z','2026-03-10Z','2026-02-01T23:59:59Z'],
  ['2026-01-13T10:00:00Z','2026-01-13T10:45:00.123456Z','2026-01-13T10:45:00.123456Z']];
 for(const [b,deadline,expected]of vectors)assert.equal(sql(`set role service_role;set timezone='Pacific/Honolulu';
  select enterprise_existing_pending_expiry(${lit(b)},${lit(deadline)})=${lit(expected)}::timestamptz`),'t');
 assert.equal(sql("set role service_role;select enterprise_existing_pending_expiry('infinity','2026-01-01Z') is null"),'t');
 const s=source({deadline:'32 minutes'}),src=claimed(s);assert.equal(Date.parse(src.expires_at),Date.parse(src.material.agreement_expires_at));
});
test('client-first lock order serializes against real sibling signing without deadlock',opts,async()=>{
 const s=source(),sibling=source({signed:false,parent:s});
 const results=await Promise.all([asyncSql(`set role service_role;${claim(s)}`),asyncSql(`set role service_role;${sealSql(sibling)}`)]);
 assert.equal(results[1].code,0,results[1].err);assert.ok([0,1].includes(results[0].code));
 if(results[0].code===1)assert.match(results[0].err,/enterprise_binding_claim_denied/);
 assert.equal(row(s).status,'superseded');assert.equal(row(sibling).status,'signed');
 assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${s.id}'`),results[0].code===0?'1':'0');
});
