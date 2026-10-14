'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {STRIPE_RECURRING_OFFER_VERSION,OFFER_VERSION}=require('../src/services/membershipOffers');
const {noticeEmail,noticeRecipientHash,noticeProviderAck,renderRetailRenewalNotice:render,processRetailRenewalNotice:processNotice}=require('../src/services/contracts/retailRenewalNotice');
function fixture(months=3,payment='prepaid',version=STRIPE_RECURRING_OFFER_VERSION){return{billing_cutoff_at:'2026-11-30T12:13:14.000Z',
 package_snapshot:buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:months,paymentOption:payment,channel:'sales',offerVersion:version})};}
const deps={escapeHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
 buildBrandedEmailShell:v=>`<main>${v.contentHtml}</main>`};
test('same accepted factory renders each3/6/12 prepay/monthly notice without new prices or obligations',()=>{
 for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
  const f=fixture(months,payment),seen=[];
  const r=render(f,{...deps,escapeHtml:v=>{seen.push(v);return deps.escapeHtml(v);}});
  assert.match(r.subject,new RegExp(`${months} months`));assert.match(r.text,/Mon, 30 Nov 2026 12:13:14 GMT/);
  assert.match(r.text,/before that renewal instant/);assert.match(r.text,/not an earlier cancellation deadline/);
  assert.match(r.text,payment==='prepaid'?/does not shorten your already-paid/:/installments still owed/);
  assert.equal(seen.length,8);assert.match(r.html,/<main>/);assert.equal(/https?:|token|password/i.test(r.text),false);
  if(months===3&&payment==='prepaid')assert.match(r.text,/\$1,200\.00 prepaid/);
  if(months===3&&payment==='monthly_installments')assert.match(r.text,/\$449\.00 per month/);
 }
});
test('missing/stale facts and noncanonical or injected cutoff hold instead of inventing notice content',()=>{
 for(const f of [fixture(3,'prepaid',OFFER_VERSION),{}, {...fixture(),billing_cutoff_at:'2026-11-30'},
  {...fixture(),billing_cutoff_at:'<script>bad</script>'},{...fixture(),billing_cutoff_at:'2026-02-31T12:00:00.000Z'}])
  assert.throws(()=>render(f,deps),{code:'retail_renewal_notice_held'});
});
test('existing plain-email grammar gives same owner hash, rejects header injection and multiple recipients',()=>{
 assert.equal(noticeEmail(' QA+Owner@Example.Invalid '),'qa+owner@example.invalid');
 assert.equal(noticeRecipientHash('QA+OWNER@example.invalid'),noticeRecipientHash('qa+owner@example.invalid'));
 for(const value of ['a@example.invalid\r\nBcc:b@example.invalid','A <a@example.invalid>','a@example.invalid,b@example.invalid',''])
  assert.throws(()=>noticeEmail(value));
});
test('provider acknowledgment is not delivery: skip/missing/timeout/serverfailure stay unknown',()=>{
 assert.deepEqual(noticeProviderAck({statusCode:202,providerReference:'synthetic-ACK'}),{outcome:'accepted',provider_reference:'synthetic-ACK'});
 assert.equal(noticeProviderAck({statusCode:400}).outcome,'rejected');
 for(const r of [undefined,null,{skipped:true},{skipped:true,statusCode:202},{statusCode:200},{statusCode:500},{statusCode:'202'}])assert.equal(noticeProviderAck(r).outcome,'unknown');
 assert.equal(noticeProviderAck({statusCode:202,providerReference:'bad\nreference'}).provider_reference,null);
});
test('existing branded mail transport takes rendered notice with no attachments or setup links (fake sender only)',async()=>{
 const filename=require.resolve('../src/clients/sendgrid'),sgPath=require.resolve('@sendgrid/mail');
 const priorModule=require.cache[filename],priorSdk=require.cache[sgPath],priorKey=process.env.SENDGRID_API_KEY;
 const sent=[];process.env.SENDGRID_API_KEY='SG.SYNTHETIC.LOCAL_ONLY';delete require.cache[filename];
 require.cache[sgPath]={id:sgPath,filename:sgPath,loaded:true,exports:{setApiKey(){},send:async msg=>{sent.push(msg);return[{statusCode:202,headers:{'x-message-id':'synthetic-ACK'}}];}}};
 try{
  const ack=await require('../src/clients/sendgrid').sendRetailRenewalNoticeEmail('QA@EXAMPLE.INVALID',fixture());
  assert.deepEqual(ack,{statusCode:202,providerReference:'synthetic-ACK'});assert.equal(sent.length,1);
  assert.equal(sent[0].to,'qa@example.invalid');assert.match(sent[0].html,/Your alphaScreen membership renewal/);
  assert.equal(Object.hasOwn(sent[0],'attachments'),false);assert.deepEqual(sent[0].categories,['retail_renewal_notice']);
 }finally{
  if(priorKey===undefined)delete process.env.SENDGRID_API_KEY;else process.env.SENDGRID_API_KEY=priorKey;
  if(priorModule)require.cache[filename]=priorModule;else delete require.cache[filename];
  if(priorSdk)require.cache[sgPath]=priorSdk;else delete require.cache[sgPath];
 }
});
test('notice flagoff/empty/malformed allowlist make no source lookup, claim or provider call',async()=>{
 const db={rpc(){throw Error('no read');},from(){throw Error('no read');}};
 for(const patch of [{},{enabled:'true'},{enabled:true,allowRecipients:[]},{enabled:true,allowRecipients:['not-email']}]){
  const result=await processNotice({db,...patch});assert.ok(['disabled','held'].includes(result.status));
 }
});
function serviceFixture(){
 const {recurringFixture}=require('./fixtures/existing-retail-recurring-funding-fixture');
 const {createFakeSupabase}=require('./helpers/fakeSupabase');
 const f=recurringFixture('basic',3,'prepaid'),s=f.source,email='owner@example.invalid',calls=[];
 const native={attempted:false,claimStatus:null,ack:null};
 const tables={membership_agreements:[{id:s.agreement_id,client_id:s.client_id,admin_email:email}],
  billing_customers:[{id:'profile',client_id:s.client_id,stripe_customer_id:s.original_period.customer_id,primary_contact_email:email}]};
 const db=createFakeSupabase(tables);
 db.rpc=async(name,args)=>{
  calls.push({name,args});if(name==='read_retail_existing_recurring_source')return{data:structuredClone(s),error:null};
  assert.equal(name,'retail_existing_renewal_notice');
  if(args.p_action==='record'){assert.equal(args.p_attempt_identity,`retail-renewal-notice:${s.agreement_id}:${fixture().billing_cutoff_at}:attempted`);native.ack=args.p_ack;return{data:{status:'recorded'},error:null};}
  if(native.claimStatus)return{data:{status:native.claimStatus},error:null};
  if(native.attempted)return{data:{status:'already_attempted'},error:null};native.attempted=true;
  return{data:{status:'claimed',attempt_identity:`retail-renewal-notice:${s.agreement_id}:${fixture().billing_cutoff_at}:attempted`,facts:{...fixture(),version:'retail_existing_renewal_notice_v1',template_version:'retail_existing_renewal_notice_v1',
   agreement_id:s.agreement_id,client_id:s.client_id,recipient_email:email,recipient_sha256:noticeRecipientHash(email),package_snapshot:s.package_snapshot}},error:null};
 };
 return{db,native,calls,tables,args:{db,agreementId:s.agreement_id,clientId:s.client_id,enabled:true,allowRecipients:[email]}};
}
test('same processor service uses committed winning claim exactly once; first API ack not delivery',async()=>{
 const f=serviceFixture();let sends=0;
 const args={...f.args,send:async(to,facts)=>{assert.equal(f.native.attempted,true);assert.equal(to,'owner@example.invalid');render(facts,deps);
  sends++;return{statusCode:202,providerReference:'fake-ack'};}};
 assert.equal((await processNotice(args)).status,'accepted');assert.equal(sends,1);assert.equal(f.native.ack.outcome,'accepted');
 assert.equal((await processNotice(args)).status,'already_attempted');assert.equal(sends,1);
 const claim=f.calls.find(c=>c.args?.p_action==='claim').args;
 assert.deepEqual(Object.keys(claim),['p_agreement','p_client','p_action','p_ack','p_expected_recipient_sha256','p_attempt_identity']);
 assert.equal(claim.p_attempt_identity,null);
 assert.equal(JSON.stringify(claim).includes('owner@example.invalid'),false);
});
test('unknown mail result is recorded once without a resend, while unapproved/changed owner never claims',async()=>{
 const f=serviceFixture();let sends=0;
 const args={...f.args,send:async()=>{sends++;throw Error('SYNTHETIC unknown provider outcome');}};
 assert.equal((await processNotice(args)).status,'unknown');assert.equal(f.native.ack.outcome,'unknown');
 await processNotice(args);assert.equal(sends,1);
 const denied=serviceFixture();denied.tables.billing_customers[0].primary_contact_email='other@example.invalid';
 assert.equal((await processNotice({...denied.args,send:async()=>{throw Error('must not send');}})).status,'held');
 assert.equal(denied.calls.some(c=>c.name==='retail_existing_renewal_notice'),false);
 const conflict=serviceFixture();conflict.native.claimStatus='held';let called=false;
 await processNotice({...conflict.args,send:async()=>{called=true;}});assert.equal(called,false);
});
