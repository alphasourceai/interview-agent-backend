'use strict';
// Actual private PostgreSQL and synthetic signed-source fixtures, no provider.
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const fixture=require('./helpers/enterprise-native-paid-period-fixture');
const {verifyExistingEnterpriseLegalWindow:verify}=require('../src/services/existingEnterpriseLegalWindow');
const enabled=process.env.ENTERPRISE_NOTICE_SNAPSHOT_DISPOSABLE==='true',opts={skip:!enabled};
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261016131828_enterprise_existing_notice_snapshot_compat.sql'),'utf8');
function run(q){return cp.spawnSync('/opt/homebrew/opt/postgresql@17/bin/psql',['-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
const lit=v=>`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`;
const catalog=()=>JSON.parse(sql("select jsonb_agg(to_jsonb(p)-'prosrc' order by oid) from pg_proc p where oid in('public.read_enterprise_existing_legal_window(uuid,uuid)'::regprocedure,'public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean)'::regprocedure)"));
before(()=>{
 if(!enabled)return;
 assert.equal(process.env.PGHOST,'/private/tmp/alphascreen-unified-schema.9GJa5t');
 assert.equal(process.env.PGPORT,'55459');assert.equal(process.env.PGUSER,'postgres');
 assert.equal(process.env.PGDATABASE,'notice_snapshot_20261016');assert.equal(process.env.PGPASSWORD,undefined);
 const before=catalog();
 for(const change of ["alter function public.read_enterprise_existing_legal_window(uuid,uuid) security definer",
  "grant execute on function public.change_enterprise_existing_renewal(uuid,uuid,jsonb,text,boolean) to anon",
  "alter function public.read_enterprise_existing_legal_window(uuid,uuid) set lock_timeout='20s'"]){
  denied('begin;'+change+';'+migration,/enterprise_notice_prerequisite_drift/);assert.deepEqual(catalog(),before);
 }
 sql(migration);assert.deepEqual(catalog(),before);
});
for(const format of ['numeric','display'])for(const cadence of ['monthly','annual'])
 test(`native ${format} ${cadence} signed-source notice uses the same accepted cutoff without rewriting`,opts,async()=>{
  const f=await fixture(sql,{noticeDays:30,noticeSnapshotFormat:format,cadence});
  const a=JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id='${f.id}'`));
  const original=structuredClone(a);
  const w=JSON.parse(sql(`set role service_role;select read_enterprise_existing_legal_window('${f.id}','${f.client}')`));
  assert.equal(verify(w,{agreement:a,billingReceipt:f.billing}).notice_cutoff_at,w.notice_cutoff_at);
  assert.equal(Date.parse(w.term_end_at)-Date.parse(w.notice_cutoff_at),30*86400000);
  const renewal=JSON.parse(sql(`set role service_role;select change_enterprise_existing_renewal('${f.id}','${f.client}',${lit(f.billing)},'read',null)`));
  assert.equal(Date.parse(renewal.notice_cutoff_at),Date.parse(w.notice_cutoff_at));
  assert.deepEqual(JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id='${f.id}'`)),original);
 });
test('native notice parser rejects missing, malformed, conflicting and inaccessible snapshots',opts,()=>{
 const row=v=>lit({notice_deadline_days:30,enterprise_checkout_source:{material:{template_snapshot:{values:v}}}});
 const read=v=>`select enterprise_existing_notice_days(jsonb_populate_record(null::membership_agreements,${row(v)}))`;
 for(const v of [{},{notice_deadline_days:null},{notice_deadline_days:30},{notice_deadline_days:'030'},
  {notice_deadline_days:'3661'},{notice_deadline_days:'31'},{notice_deadline_days:'30 Days'},
  {notice_deadline_days:'30',notice_deadline_plain:null},{notice_deadline_days:'30',notice_deadline_plain:'31'}])
  denied('set role service_role;'+read(v),/enterprise_renewal_notice_denied/);
 for(const role of ['anon','authenticated'])denied(`set role ${role};`+read({notice_deadline_days:'30'}),/permission denied/);
 assert.equal(sql('set role service_role;'+read({notice_deadline_days:'30'})),'30');
 assert.equal(sql('set role service_role;'+read({notice_deadline_days:'30 Days',notice_deadline_plain:'30'})),'30');
 denied(migration,/enterprise_notice_schema_drift/);
});
