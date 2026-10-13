'use strict';
// Actual local PostgreSQL/seals/pins + injected SDK data. No Auth/provider access.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const fundingEnabled=process.env.ENTERPRISE_FUNDING_DISPOSABLE==='true';
const traceEnabled=process.env.ENTERPRISE_TRACE_DISPOSABLE==='true'||fundingEnabled;
const fundingOpts={skip:!fundingEnabled};
const enabled=process.env.ENTERPRISE_PENDING_DISPOSABLE==='true'||traceEnabled,opts={skip:!enabled||traceEnabled},traceOpts={skip:!traceEnabled},socket=process.env.PGHOST||'',port='55452';
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
function source({cadence='monthly',fees={},signed=true,deadline='1 day',marked=true,parent,rawToken=crypto.randomBytes(32).toString('hex')}={}){
 const id=crypto.randomUUID(),client=parent?.client||crypto.randomUUID(),token=crypto.createHash('sha256').update(rawToken).digest('hex'),customer=parent?.customer||`cus_SYNTHETIC_${client.replaceAll('-','')}`;
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
 const s={id,client,customer,token,rawToken,snapshot};
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
 if(traceEnabled){
  const newSql=fs.readFileSync(path.join(root,'20261013105137_enterprise_existing_checkout_trace_pins.sql'),'utf8');
  for(const change of ["alter table membership_agreements disable trigger enterprise_existing_pending_agreement_pair",
   "alter table membership_agreements disable row level security","grant select on client_interview_pools to anon",
   "alter table client_interview_pools drop constraint client_interview_pools_total_check;alter table client_interview_pools add constraint client_interview_pools_total_check check(true)",
   "alter table membership_agreements alter column enterprise_checkout_source type text",
   "create or replace function enterprise_existing_pending_expiry(b timestamptz,legal_deadline timestamptz) returns timestamptz language sql as $$select legal_deadline$$"])
   denied(`begin;${change};${newSql}`,/enterprise_trace_.*drift/);
  apply('20261013105137_enterprise_existing_checkout_trace_pins.sql');
  denied(newSql,/enterprise_trace_prerequisite_drift|enterprise_trace_schema_acl_drift/);
  sql(`alter table clients add column name text not null default 'SYNTHETIC ONLY',add column email text not null default 'owner@example.invalid',add column client_admin_name text,add column stripe_subscription_id text;
   create table billing_customers(id uuid primary key default gen_random_uuid(),client_id uuid references clients(id) on delete set null,name text not null,
    primary_contact_name text,primary_contact_email text not null,notes text,stripe_customer_id text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
   create unique index billing_customers_stripe_customer_id_uniq on billing_customers(stripe_customer_id) where stripe_customer_id is not null;
   alter table billing_customers enable row level security;grant select,insert on billing_customers to service_role;`);
  if(fundingEnabled){
   // Existing QA schema grants service_role UPDATE; row locking needs it even
   // though the receipt RPC never updates the owner profile. Fixture only.
   sql('grant update on billing_customers to service_role');
   const newSql=fs.readFileSync(path.join(root,'20261013125114_enterprise_existing_funding_receipts.sql'),'utf8');
   for(const change of ["alter table membership_agreements disable trigger enterprise_existing_pending_agreement_guard",
    "alter table billing_customers disable row level security","revoke update on billing_customers from service_role","drop index billing_customers_stripe_customer_id_uniq",
    "alter table clients alter column stripe_subscription_id type varchar",
    "create or replace function enterprise_existing_pending_expiry(b timestamptz,legal_deadline timestamptz) returns timestamptz language sql as $$select legal_deadline$$"])
    denied(`begin;${change};${newSql}`,/enterprise_funding_.*drift/);
   apply('20261013125114_enterprise_existing_funding_receipts.sql');
   denied(newSql,/enterprise_funding_schema_acl_drift|enterprise_funding_owner_schema_drift/);
  }
 }
});

// Receipt-only native checks use real-clock A and actual sealed/pinned rows.
// Direct scalar proof fixtures do not authenticate Stripe or prove bank cash.
async function fundingSource({cs,replacement=null,cadence='monthly'}={}){
 const s=source({cadence}),suffix=s.id.replaceAll('-',''),a=prepared(s,{replacement}),p=priced(s,a);
 sql(`set role service_role;${pinSession(s,p,cs||'cs_RECEIPT_'+suffix)}
  insert into billing_customers(client_id,name,primary_contact_email,stripe_customer_id) values('${s.client}','SYNTHETIC','owner@example.invalid','${s.customer}');`);
 if(replacement)sql(`update clients set stripe_subscription_id='${replacement}' where id='${s.client}'`);
 await new Promise(resolve=>setTimeout(resolve,1100));
 const r=row(s),poolRow=pool(s),clock=Number(sql('select floor(extract(epoch from clock_timestamp()))'));
 const pure=require('./helpers/enterprise-pool-payment-fixture')({platformCents:99999,platformInterval:cadence==='annual'?'year':'month'});
 const proof={...require('../src/services/enterprisePoolPaymentProof').proveEnterprisePoolPayment(pure),pool_id:poolRow.id,client_id:s.client,
  provider_account_id:'acct_RECEIPT',customer_id:s.customer,checkout_session_id:r.checkout_session_id,
  subscription_id:'sub_RECEIPT_'+suffix,invoice_id:'in_RECEIPT_'+suffix,payment_intent_id:'pi_RECEIPT_'+suffix,charge_id:'ch_RECEIPT_'+suffix,
  platform_price_id:r.enterprise_checkout_prices.platform_price_id,pool_price_id:r.enterprise_checkout_prices.pool_price_id,
  payment_success_at:new Date(clock*1000).toISOString()};
 return {s,r,proof};
}
function receiptCall(n,proof=n.proof,patch={}){
 return `select record_enterprise_existing_funding(${[n.s.id,n.s.client,patch.source||n.r.enterprise_checkout_source,
  patch.prices||n.r.enterprise_checkout_prices,proof].map(lit).join(',')});`;
}
test('native receipt firstrecord/same replay has29 fields, original A and one native stamp, no paid state',fundingOpts,async()=>{
 const n=await fundingSource(),p=pool(n.s),before=row(n.s),w=JSON.parse(sql('set role service_role;'+receiptCall(n)));
 assert.equal(Object.keys(w.proof).length,29);assert.equal(w.proof.payment_success_at,n.proof.payment_success_at);
 assert.match(w.recorded_at,/\.\d{6}Z$/);assert.deepEqual(JSON.parse(sql('set role service_role;'+receiptCall(n))),w);
 const after=row(n.s);delete after.enterprise_funding_receipt;delete before.enterprise_funding_receipt;assert.deepEqual(after,before);assert.deepEqual(pool(n.s),p);
 for(const change of ['enterprise_funding_receipt=null',"enterprise_funding_receipt=jsonb_set(enterprise_funding_receipt,'{proof,collected_cents}','1')"])
  denied(`set role service_role;update membership_agreements set ${change} where id='${n.s.id}'`,/enterprise_funding_immutable/);
 denied(`delete from membership_agreements where id='${n.s.id}'`,/enterprise_funding_immutable/);
});
test('native receipt distinct proof/source/caller stamp cannot overwrite or backfill legacy',fundingOpts,async()=>{
 const n=await fundingSource(),before=row(n.s);
 const wrapper={version:'enterprise_existing_funding_v1',proof:n.proof,recorded_at:'2026-01-01T00:00:00.000000Z'};
 denied(`set role service_role;update membership_agreements set enterprise_funding_receipt=${lit(wrapper)} where id='${n.s.id}'`,/stamp_required/);
 denied(`set role service_role;update membership_agreements set enterprise_funding_receipt=${lit({...wrapper,recorded_at:null})} where id='${legacy.id}'`,/source_denied/);
 assert.deepEqual(row(n.s),before);sql('set role service_role;'+receiptCall(n));const stored=row(n.s).enterprise_funding_receipt;
 denied('set role service_role;'+receiptCall(n,{...n.proof,invoice_id:'in_OTHER'}),/receipt_conflict/);
 denied('set role service_role;'+receiptCall(n,n.proof,{source:{}}),/source_denied/);
 assert.deepEqual(row(n.s).enterprise_funding_receipt,stored);
});
test('native receipt strict shape/cents/types/identity/clock cases refuse independently before any record',fundingOpts,async()=>{
 const n=await fundingSource(),before=row(n.s);
 const changes=[p=>{p.extra=true;},p=>{delete p.invoice_id;},p=>{p.invoice_id=null;},p=>{p.quantity=0;},p=>{p.pool_paid_cents=0;},
  p=>{p.platform_nominal_cents='99999';},p=>{p.platform_line_cents=1.5;},p=>{p.collected_cents=2147483648;},p=>{p.pool_tax_cents=1;},
  p=>{p.collected_cents--;},p=>{p.credits_spendable=true;},p=>{p.membership_activation_required=false;},p=>{p.native_receipt_required=false;},
  p=>{p.livemode='false';},p=>{p.currency='eur';},p=>{p.offer_digest='0'.repeat(64);},p=>{p.customer_id='cus_OTHER';},
  p=>{p.pool_id=crypto.randomUUID();},p=>{p.client_id=crypto.randomUUID();},p=>{p.checkout_session_id='cs_OTHER';},
  p=>{p.platform_price_id='price_OTHER';},p=>{p.platform_interval='week';},p=>{p.platform_nominal_cents--;},
  p=>{p.payment_success_at=p.payment_success_at.replace('.000Z','Z');},p=>{p.payment_success_at='infinity';},
  p=>{p.payment_success_at=new Date(Date.now()+100000).toISOString().replace(/\.\d{3}Z$/,'.000Z');},
  p=>{p.payment_success_at=new Date(Math.floor(Date.parse(n.r.enterprise_checkout_source.created_at)/1000)*1000-1000).toISOString();}];
 for(const change of changes){const p=structuredClone(n.proof);change(p);denied('set role service_role;'+receiptCall(n,p),/proof_denied/);assert.deepEqual(row(n.s),before);}
 const legalProof={...n.proof,payment_success_at:new Date(Math.ceil(Date.parse(n.r.agreement_expires_at)/1000)*1000).toISOString()};
 const futureWrapper={version:'enterprise_existing_funding_v1',proof:legalProof,recorded_at:new Date(Date.parse(legalProof.payment_success_at)+1000).toISOString().replace('.000Z','.000000Z')};
 assert.equal(sql(`set role service_role;select enterprise_existing_funding_receipt_valid(${lit(futureWrapper)},${lit(n.r.enterprise_checkout_source)},${lit(n.r.enterprise_checkout_prices)})`),'f');
});
test('native receipt replacement subscription may not substitute for new Checkout subscription',fundingOpts,async()=>{
 const n=await fundingSource({replacement:'sub_ORIGINAL'});denied('set role service_role;'+receiptCall(n,{...n.proof,subscription_id:'sub_ORIGINAL'}),/proof_denied/);
 assert.equal(row(n.s).enterprise_funding_receipt,null);sql('set role service_role;'+receiptCall(n));
});
test('native receipt concurrency matches one original stamp and conflicts rollback',fundingOpts,async()=>{
 const n=await fundingSource(),r=await Promise.all([asyncSql('set role service_role;'+receiptCall(n)),asyncSql('set role service_role;'+receiptCall(n))]);
 for(const x of r)assert.equal(x.code,0,x.err);assert.deepEqual(JSON.parse(r[0].out),JSON.parse(r[1].out));
});
test('native receipt late failure rolls ledger write back; retry records once',fundingOpts,async()=>{
 const n=await fundingSource(),before=row(n.s);
 denied(`begin;create function synthetic_receipt_failure() returns trigger language plpgsql as $$begin
 if new.id='${n.s.id}'::uuid and new.enterprise_funding_receipt is not null then raise exception 'SYNTHETIC receipt late failure';end if;return new;end$$;
 create trigger synthetic_receipt_failure after update on membership_agreements for each row execute function synthetic_receipt_failure();
 set role service_role;${receiptCall(n)};commit;`,/SYNTHETIC receipt late failure/);
 assert.deepEqual(row(n.s),before);sql('set role service_role;'+receiptCall(n));
});
for(const [field,index]of [['checkout_session_id','checkout'],['subscription_id','subscription'],['invoice_id','invoice'],['payment_intent_id','pi'],['charge_id','charge']])
 test(`native one account/mode/${field} cash graph cannot record on another source`,fundingOpts,async()=>{
  const first=await fundingSource();sql('set role service_role;'+receiptCall(first));
  const second=await fundingSource(field==='checkout_session_id'?{cs:first.proof.checkout_session_id}:{}),before=row(second.s);
  const p={...second.proof,[field]:first.proof[field]};
  denied('set role service_role;'+receiptCall(second,p),new RegExp('enterprise_funding_one_'+index));assert.deepEqual(row(second.s),before);
 });
test('native receipt browser/RLS denied, invoker locks bounded and all original paid guards remain',fundingOpts,async()=>{
 const n=await fundingSource();for(const role of ['anon','authenticated'])denied('set role '+role+';'+receiptCall(n),/permission denied/);
 denied(receiptCall(n),/server_only/);assert.equal(sql("select proconfig::text from pg_proc where proname='record_enterprise_existing_funding'"),'{search_path=pg_catalog,lock_timeout=10s}');
 assert.equal(sql("select count(*) from pg_proc where proname like 'enterprise_existing_funding_%' and prosecdef"),'0');
 sql('set role service_role;'+receiptCall(n));const a=row(n.s),p=pool(n.s);
 denied(`set role service_role;update membership_agreements set checkout_status='paid',checkout_paid_at=clock_timestamp() where id='${n.s.id}'`,/enterprise_binding_pending_only/);
 denied(`set role service_role;update client_interview_pools set status='paid',paid_at=clock_timestamp() where id='${p.id}'`,/enterprise_/);
 assert.deepEqual(row(n.s),a);assert.deepEqual(pool(n.s),p);assert.equal(acl(),permissions);
});
async function waitNativeState(name,predicate){
 for(let attempt=0;attempt<35;attempt++){
  if(sql(`select count(*) from pg_stat_activity where application_name=${lit(name)} and ${predicate}`)==='1')return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }assert.fail('SYNTHETIC expected native state '+name);
}
test('real owner reassignment blocks behind receipt FOR SHARE until commit, then replay refuses foreign owner',fundingOpts,async()=>{
 const n=await fundingSource(),other=source(),holderName='SYNTHETIC_RECEIPT_HOLDER',updateName='SYNTHETIC_RECEIPT_OWNER_UPDATE';
 const holder=asyncSql(`begin;set application_name=${lit(holderName)};set role service_role;${receiptCall(n)}select pg_sleep(2);commit;`);
 await waitNativeState(holderName,"wait_event='PgSleep'");
 const change=asyncSql(`set application_name=${lit(updateName)};update billing_customers set client_id='${other.client}' where stripe_customer_id='${n.s.customer}'`);
 await waitNativeState(updateName,"wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0");
 const [h,u]=await Promise.all([holder,change]);assert.equal(h.code,0,h.err);assert.equal(u.code,0,u.err);
 assert.equal(row(n.s).enterprise_funding_receipt.proof.client_id,n.s.client);
 denied('set role service_role;'+receiptCall(n),/binding_denied/);assert.equal(pool(n.s).status,'pending');
});
test('real receipt/signing race uses client-first order, retains inert historical receipt without reactivation',fundingOpts,async()=>{
 const n=await fundingSource(),sibling=source({signed:false,parent:n.s});
 const [receipt,sign]=await Promise.all([asyncSql('set role service_role;'+receiptCall(n)),asyncSql('set role service_role;'+sealSql(sibling))]);
 assert.equal(sign.code,0,sign.err);assert.ok([0,1].includes(receipt.code));
 if(receipt.code===1)assert.match(receipt.err,/source_denied/);
 assert.equal(row(n.s).status,'superseded');assert.equal(pool(n.s).status,'pending');
 denied('set role service_role;'+receiptCall(n),/source_denied/);
});
test('native current source/globalowner/parent/intent failures do not record funding',fundingOpts,async()=>{
 const n=await fundingSource(),before=row(n.s),other=source();
 for(const change of [`update clients set parent_client_id='${other.client}' where id='${n.s.client}'`,
  `update clients set stripe_subscription_id='sub_OTHER' where id='${n.s.client}'`,
  `update billing_customers set client_id='${other.client}' where stripe_customer_id='${n.s.customer}'`,
  `insert into public_purchase_intents(agreement_id) values('${n.s.id}')`]){
  denied(`begin;${change};set role service_role;${receiptCall(n)}commit;`,/source_denied|binding_denied|enterprise_binding/);assert.deepEqual(row(n.s),before);
 }
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

const prices={platform_price_id:'price_SYNTHETIC_PLATFORM',pool_price_id:'price_SYNTHETIC_POOL'};
function prepare(s,settings={}){return claim(s,settings).replace('claim_enterprise_existing_pending_checkout','prepare_enterprise_existing_checkout');}
const prepared=(s,settings)=>JSON.parse(sql(`set role service_role;${prepare(s,settings)}`));
function pinPrices(s,a,p=prices){return `select pin_enterprise_existing_checkout_prices(${[s.id,s.client,a.source,p].map(lit).join(',')});`;}
function pinSession(s,a,cs='cs_SYNTHETIC'){return `select pin_enterprise_existing_checkout_session(${[s.id,s.client,a.source,a.prices,cs].map(lit).join(',')});`;}
const priced=(s,a=prepared(s))=>JSON.parse(sql(`set role service_role;${pinPrices(s,a)}`));
const pinned=(s,a=priced(s))=>JSON.parse(sql(`set role service_role;${pinSession(s,a)}`));
for(const cadence of ['monthly','annual'])for(const embedded of [true,false])test(`actual native ${cadence}/${embedded} prices/CS pin links both rows and frozen B`,traceOpts,()=>{
 const s=source({cadence}),a=prepared(s,{embedded,replacement:'sub_NATIVE'}),p=priced(s,a),cs=pinned(s,p),r=row(s),b=pool(s);
 assert.deepEqual(p.prices,prices);assert.equal(p.checkout_session_id,null);assert.equal(cs.checkout_session_id,'cs_SYNTHETIC');
 assert.equal(r.checkout_session_id,b.stripe_checkout_session_id);assert.equal(r.checkout_status,'pending_payment');
 assert.equal(Date.parse(r.checkout_created_at),Date.parse(a.source.created_at));assert.equal(r.replaces_stripe_subscription_id,'sub_NATIVE');
 assert.equal(r.replacement_policy,'immediate_cancel');assert.equal(r.checkout_paid_at,null);assert.equal(b.paid_at,null);assert.equal(b.status,'pending');
 assert.equal(r.checkout_attempt_source,null);assert.equal(r.checkout_embedded,null);assert.deepEqual(cs.source,a.source);
 assert.deepEqual(prepared(s,{embedded,replacement:'sub_OTHER'}),cs);assert.deepEqual(pinned(s,p),cs);
 denied(`set role service_role;${claim(s,{embedded})}`,/enterprise_binding_claim_denied/); // old claim is unchanged and intentionally no longer a replay after CS.
});
test('actual native first pair freezes, concurrent identical pins win; different pair refuses',traceOpts,async()=>{
 const s=source(),a=prepared(s);const r=await Promise.all([asyncSql(`set role service_role;${pinPrices(s,a)}`),asyncSql(`set role service_role;${pinPrices(s,a)}`)]);
 for(const x of r)assert.equal(x.code,0,x.err);assert.deepEqual(JSON.parse(r[0].out),JSON.parse(r[1].out));
 for(const p of [{...prices,pool_price_id:'price_OTHER'},{...prices,extra:'bad'},{platform_price_id:prices.pool_price_id,pool_price_id:prices.pool_price_id},null])
  denied(`set role service_role;${pinPrices(s,a,p)}`,/enterprise_trace_prices/);
 denied(`set role service_role;update membership_agreements set enterprise_checkout_prices=null where id='${s.id}'`,/prices_immutable/);
});
test('actual native concurrent sameCS pins commit one winner; different CS refuses and preserves both links',traceOpts,async()=>{
 const s=source(),a=priced(s);const r=await Promise.all([asyncSql(`set role service_role;${pinSession(s,a)}`),asyncSql(`set role service_role;${pinSession(s,a)}`)]);
 for(const x of r)assert.equal(x.code,0,x.err);assert.deepEqual(JSON.parse(r[0].out),JSON.parse(r[1].out));
 denied(`set role service_role;${pinSession(s,a,'cs_OTHER')}`,/session_immutable/);
 assert.equal(row(s).checkout_session_id,'cs_SYNTHETIC');assert.equal(pool(s).stripe_checkout_session_id,'cs_SYNTHETIC');
});
test('actual native missing prices, stale source, wrong customer/client/config/mode refuse before trace',traceOpts,()=>{
 const s=source(),a=prepared(s);denied(`set role service_role;${pinSession(s,a)}`,/session_denied/);
 for(const patch of [{customer:'cus_OTHER'},{target:crypto.randomUUID()},{embedded:true},{expected:{}},{configuration:{...config,public_sign_base:'https://other.example.invalid'}}])
  denied(`set role service_role;${prepare(s,patch)}`,/enterprise_trace_/);
 const forged={...a,source:{...a.source,created_at:'2020-01-01T00:00:00.000Z'}};denied(`set role service_role;${pinPrices(s,forged)}`,/source_denied/);
 sql(`update clients set stripe_customer_id='cus_CHANGED' where id='${s.client}'`);denied(`set role service_role;${pinPrices(s,a)}`,/source_denied/);
 assert.equal(row(s).enterprise_checkout_prices,null);assert.equal(pool(s).stripe_checkout_session_id,null);
});
test('actual native CS pin late failure rolls BOTH trace links back, price winner remains',traceOpts,()=>{
 const s=source(),a=priced(s),before=row(s),p=pool(s);
 denied(`begin;create function synthetic_pin_failure() returns trigger language plpgsql as $$begin
 if new.id='${s.id}'::uuid and new.checkout_session_id is not null then raise exception 'SYNTHETIC late pin';end if;return new;end$$;
 create trigger synthetic_pin_failure after update on membership_agreements for each row execute function synthetic_pin_failure();
 set role service_role;${pinSession(s,a)};commit;`,/SYNTHETIC late pin/);
 assert.deepEqual(row(s),before);assert.deepEqual(pool(s),p);assert.deepEqual(priced(s,a).prices,prices);
});
test('actual native deferred pair rejects pool-only CS and isolated wrong-client fault; rollback preserves guards',traceOpts,()=>{
 const s=source(),a=priced(s),p=pool(s),other=source();
 denied(`set role service_role;update client_interview_pools set stripe_checkout_session_id='cs_ORPHAN' where id='${p.id}'`,/pair_denied/);
 // Rollback-only local fault injection isolates the deferred pair, rather than
 // claiming the earlier immutable client trigger exercised this predicate.
 denied(`begin;alter table client_interview_pools disable trigger enterprise_pool_v2_guard_pool;set role service_role;
 update client_interview_pools set client_id='${other.client}' where id='${p.id}';commit;`,/pair_denied/);
 assert.deepEqual(pool(s),p);assert.equal(sql("select tgenabled from pg_trigger where tgname='enterprise_pool_v2_guard_pool'"),'O');
});
test('actual native copied/source-less prices and expired legal window cannot write new trace',traceOpts,()=>{
 const s=source();denied(`set role service_role;update membership_agreements set enterprise_checkout_prices=${lit(prices)} where id='${s.id}'`,/claim_required|prices_denied/);
 const expired=source({deadline:'10 minutes'});denied(`set role service_role;${prepare(expired)}`,/window_denied/);
 assert.equal(row(expired).enterprise_checkout_source,null);assert.equal(sql(`select count(*) from client_interview_pools where agreement_id='${expired.id}'`),'0');
});
test('actual native trace still denies paid/PI/credit release and retains legacy ACL/source/old claim',traceOpts,()=>{
 const s=source(),a=pinned(s),before=row(s),p=pool(s);assert.equal(acl(),permissions);
 for(const update of ["checkout_paid_at=clock_timestamp()","checkout_status='paid'","checkout_created_at=clock_timestamp()","replaces_stripe_subscription_id='sub_OTHER'"])
  denied(`set role service_role;update membership_agreements set ${update} where id='${s.id}'`,/enterprise_/);
 for(const update of ["status='paid',paid_at=clock_timestamp()","stripe_payment_intent_id='pi_FORGED'","stripe_checkout_session_id=null"])
  denied(`set role service_role;update client_interview_pools set ${update} where id='${p.id}'`,/enterprise_/);
 assert.deepEqual(row(s),before);assert.deepEqual(pool(s),p);
 assert.equal(sql("select md5(prosrc) from pg_proc where oid='claim_enterprise_existing_pending_checkout(uuid,uuid,jsonb,text,boolean,text,jsonb)'::regprocedure"),'081cb824284105a582d792f24eb453aa');
 for(const role of ['anon','authenticated'])for(const q of [prepare(s),pinPrices(s,a),pinSession(s,a)])denied(`set role ${role};${q}`,/permission denied/);
 const l=row(legacy);delete l.enterprise_checkout_source;delete l.enterprise_checkout_pool_id;delete l.enterprise_checkout_prices;if(fundingEnabled)delete l.enterprise_funding_receipt;assert.deepEqual(l,legacyRow);
});
// Small explicit native query adapter for the existing JS helper. This is not
// hosted PostgREST: SQL, constraints, guards, seals and pins are real PG17;
// provider objects remain injected synthetic SDK data.
class NativeQuery{
 constructor(table){assert.ok(['membership_agreements','enterprise_v2_execution_seals','public_purchase_intents','clients','billing_customers','client_interview_pools'].includes(table));this.table=table;this.fields='*';this.filters=[];}
 select(fields='*'){assert.match(fields,/^(\*|[a-z_]+(,[a-z_]+)*)$/);this.fields=fields;return this;}
 eq(k,v){assert.match(k,/^[a-z_]+$/);this.filters.push(`${k}${v==null?' is null':'='+lit(v)}`);return this;}
 is(k,v){return this.eq(k,v);}order(){return this;}update(p){this.change=p;return this;}insert(p){this.add=p;return this;}
 async execute(){
  const where=this.filters.length?' where '+this.filters.join(' and '):'';let query;
  if(this.add){assert.equal(this.table,'billing_customers');query=`insert into public.${this.table}(${Object.keys(this.add).join(',')}) values(${Object.values(this.add).map(lit).join(',')}) returning ${this.fields}`;}
  else if(this.change){assert.equal(this.table,'clients');query=`update public.clients set ${Object.entries(this.change).map(([k,v])=>`${k}=${lit(v)}`).join(',')}${where} returning ${this.fields}`;}
  else query=`select ${this.fields} from public.${this.table}${where}`;
  const q=(this.add||this.change)?`with changed as(${query}) select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from changed x`:
   `select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from(${query}) x`;
  const r=run('set role service_role;'+q);if(r.status!==0)return{data:null,error:{message:r.stderr,code:/unique constraint/.test(r.stderr)?'23505':undefined}};
  const rows=JSON.parse(r.stdout.trim());return{data:rows,error:null,count:rows.length};
 }
 then(resolve,reject){return this.execute().then(resolve,reject);}async maybeSingle(){const r=await this.execute();return{data:r.data?.[0]||null,error:r.error};}async single(){return this.maybeSingle();}
}
const nativeDb={from:table=>new NativeQuery(table),async rpc(name,args){
 assert.ok(['prepare_enterprise_existing_checkout','pin_enterprise_existing_checkout_prices','pin_enterprise_existing_checkout_session','record_enterprise_existing_funding'].includes(name));
 const r=run(`set role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>`${k} := ${lit(v)}`).join(',')});`);
 if(r.status!==0){if(fundingEnabled)console.error('SYNTHETIC native RPC failure:',r.stderr);return{data:null,error:{message:r.stderr}};}return{data:JSON.parse(r.stdout.trim()),error:null};
}};
for(const cadence of ['monthly','annual'])for(const embedded of [true,false])test(`actual existing JS Checkout -> real sealed PG price+CS pins ${cadence}/${embedded}`,traceOpts,async()=>{
 const {createExistingEnterpriseCheckout}=require('../src/services/existingEnterpriseCheckoutAttempt');
 const {fixture}=require('./helpers/enterprise-existing-checkout-fixture');
 const s=source({cadence}),a=row(s),mock=fixture({cadence,embedded,platformSubtotal:0});
 if(fundingEnabled){
  const original=mock.stripe.checkout.sessions.create,unique='cs_NATIVE_'+s.id.replaceAll('-','');
  mock.stripe.checkout.sessions.create=async(...args)=>{const cs=await original(...args);if(cs.id!==unique){const saved=mock.sessionStore.get(cs.id);
   saved.cs.id=unique;mock.sessionStore.set(unique,saved);mock.sessionStore.delete(cs.id);}return{...cs,id:unique};};
 }
 const args={db:nativeDb,client:JSON.parse(sql(`select to_jsonb(c) from clients c where id='${s.client}'`)),agreement:a,fees:s.snapshot.values,billingInterval:cadence,embedded,
  cancelUrl:`${config.public_sign_base}/membership-agreement/sign/${s.rawToken}`,key:`agreement_checkout:${s.id}:enterprise:${cadence}`,config,
  stripeFactory:()=>mock.stripe,resolveCustomer:async()=>s.customer};
 const result=await createExistingEnterpriseCheckout(args),r=row(s),p=pool(s);
 assert.equal(result.enterpriseAttemptLinked,true);assert.equal(result.fallbackSession,null);assert.equal(r.checkout_session_id,p.stripe_checkout_session_id);
 assert.equal(p.status,'pending');assert.equal(p.paid_at,null);assert.equal(p.stripe_payment_intent_id,null);assert.equal(r.checkout_paid_at,null);
 assert.equal(sql(`select count(*) from billing_customers where client_id='${s.client}' and stripe_customer_id='${s.customer}'`),'1');
 assert.equal(mock.calls.filter(c=>c.kind==='priceCreate').length,2);assert.equal(mock.calls.filter(c=>c.kind==='sessionCreate').length,1);
 const retry=await createExistingEnterpriseCheckout(args);assert.equal(retry.session.id,result.session.id);
 assert.equal(mock.calls.filter(c=>c.kind==='priceCreate').length,2);assert.equal(mock.calls.filter(c=>c.kind==='sessionCreate').length,1);
 assert.equal(row(s).enterprise_checkout_source.created_at,r.enterprise_checkout_source.created_at);
 // Read the payment graph against these REAL native rows and signing seals,
 // not the in-process source mock. Provider cash is still explicitly injected.
 const {readExistingEnterpriseCheckoutFunding}=require('../src/services/existingEnterpriseCheckoutFunding');
 const paid=require('./helpers/enterprise-pool-payment-fixture')({platformAmount:0,platformCents:99999,platformInterval:cadence==='annual'?'year':'month'});
 const b=Math.floor(Date.parse(r.enterprise_checkout_source.created_at)/1000),actualPrice=mock.priceStore,suffix=s.id.replaceAll('-','');
 for(const price of actualPrice.values())Object.assign(price,{created:b,custom_unit_amount:null,transform_quantity:null,tiers_mode:null});
 const platform=actualPrice.get(r.enterprise_checkout_prices.platform_price_id),oneTime=actualPrice.get(r.enterprise_checkout_prices.pool_price_id);
 for(const object of [paid.checkout,paid.subscription,paid.invoice,paid.paymentIntent,paid.charge])Object.assign(object,{customer:s.customer,created:b+(fundingEnabled?0:3)});
 let paidClock=b+10;
 if(fundingEnabled){
  await new Promise(resolve=>setTimeout(resolve,1100));paidClock=Number(sql('select floor(extract(epoch from clock_timestamp()))'));
  paid.subscription.id='sub_NATIVE_'+suffix;paid.invoice.id='in_NATIVE_'+suffix;paid.paymentIntent.id='pi_NATIVE_'+suffix;paid.charge.id='ch_NATIVE_'+suffix;
  paid.subscription.items.data[0].subscription=paid.subscription.id;paid.subscription.items.data[0].id='si_NATIVE_'+suffix;
  paid.invoice.subscription=paid.subscription.id;paid.invoice.payment_intent=paid.paymentIntent.id;paid.invoice.charge=paid.charge.id;
  paid.invoice.lines.data[0].subscription=paid.subscription.id;paid.invoice.lines.data[0].subscription_item=paid.subscription.items.data[0].id;
  paid.paymentIntent.invoice=paid.invoice.id;paid.paymentIntent.latest_charge=paid.charge.id;paid.charge.invoice=paid.invoice.id;paid.charge.payment_intent=paid.paymentIntent.id;
 }
 paid.checkout.created=b+(fundingEnabled?0:2);paid.invoice.status_transitions.paid_at=paidClock;
 for(const line of [...paid.subscription.items.data,...paid.invoice.lines.data,...paid.checkoutLines.data])
  line.price=structuredClone(line.price.type==='recurring'?platform:oneTime);
 paid.subscription.items.data[0].object='subscription_item';delete paid.subscription.items.data[0].discounts;delete paid.subscription.discounts;
 for(const line of paid.invoice.lines.data){delete line.invoice;line.discounts=null;line.discount_amounts=null;}
 paid.invoice.discounts=null;paid.invoice.total_discount_amounts=null;paid.charge.refunds=null;delete paid.charge.dispute;
 const saved=mock.sessionStore.get(r.checkout_session_id).cs;
 Object.assign(saved,{created:b+(fundingEnabled?0:2),status:'complete',payment_status:'paid',subscription:paid.subscription.id,invoice:paid.invoice.id,payment_intent:null});
 paid.subscription.metadata=structuredClone(saved.metadata);
 const originalBody=mock.calls.find(c=>c.kind==='sessionCreate').body;
 paid.subscription.billing_cycle_anchor=originalBody.subscription_data.billing_cycle_anchor;
 mock.stripe.getApiField=k=>k==='version'?'2023-10-16':undefined;
 mock.stripe.accounts={retrieve:async()=>structuredClone(paid.account)};
 mock.stripe.subscriptions.retrieve=async()=>structuredClone(paid.subscription);
 mock.stripe.subscriptionItems={list:async()=>structuredClone(paid.subscription.items)};
 mock.stripe.checkout.sessions.listLineItems=async()=>structuredClone(paid.checkoutLines);
 mock.stripe.invoices={retrieve:async()=>structuredClone(paid.invoice),listLineItems:async()=>structuredClone(paid.invoice.lines)};
 mock.stripe.paymentIntents={retrieve:async()=>structuredClone(paid.paymentIntent)};
 mock.stripe.charges={retrieve:async()=>structuredClone(paid.charge)};
 mock.stripe.refunds={list:async()=>structuredClone(paid.refunds)};
 const proof=await readExistingEnterpriseCheckoutFunding({db:nativeDb,stripe:mock.stripe,agreementId:s.id,now:()=> (b+20)*1000});
 assert.equal(proof.agreementId,s.id);assert.equal(proof.pool_id,p.id);assert.equal(proof.pool_paid_cents,p.total_cents);
 assert.equal(proof.checkout_session_id,r.checkout_session_id);assert.equal(proof.payment_success_at,new Date(paidClock*1000).toISOString());
 assert.equal(proof.credits_spendable,false);assert.equal(proof.membership_activation_required,true);assert.equal(proof.native_receipt_required,true);
 assert.deepEqual(row(s),r);assert.deepEqual(pool(s),p); // no billing or credit write
 if(fundingEnabled){
  const {recordExistingEnterpriseFunding}=require('../src/services/existingEnterpriseFundingReceipt');
  const record=await recordExistingEnterpriseFunding({db:nativeDb,stripe:mock.stripe,agreementId:s.id,now:()=>Date.now()});
  assert.equal(record.receipt.proof.payment_success_at,proof.payment_success_at);assert.deepEqual(row(s).enterprise_funding_receipt,structuredClone(record.receipt));
  const replay=await recordExistingEnterpriseFunding({db:nativeDb,stripe:mock.stripe,agreementId:s.id});assert.deepEqual(replay.receipt,record.receipt);
  assert.equal(row(s).checkout_paid_at,null);assert.equal(row(s).checkout_status,'pending_payment');assert.deepEqual(pool(s),p);
 }
});
