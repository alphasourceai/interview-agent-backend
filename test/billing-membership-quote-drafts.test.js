'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const crypto = require('node:crypto');
const {OFFER_VERSION,buildRetailOffer,listRetailOffers} = require('../src/services/membershipOffers');
const {createMembershipQuoteDraftService,QUOTE_LIFETIME_MS,TEMPLATE_VERSION} = require('../src/services/membershipQuoteDrafts');
const rep = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const client = '10000000-0000-4000-8000-000000000003';
const scope = '10000000-0000-4000-8000-000000000004';
const other = '10000000-0000-4000-8000-000000000005';
const quoteId = '20000000-0000-4000-8000-000000000001';
const start = '2026-10-11T12:00:00.000Z';
const choose = {planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION};
function authorization(audience='sales', changes={}) {
  return {scope_id:scope,audience,issuer_user_id:audience === 'public' ? null : rep,
    original_salesperson_user_id:audience === 'public' ? null : rep,client_id:null,billing_owner_user_id:null,...changes};
}
function fixture({auth=authorization(),authorize,clock,newId=()=>quoteId,insertFailure=null,readFailure=null,catalog,agreement}={}) {
  const rows = new Map();const calls=[];let instant=start;
  const db = {from(table) {
    assert.equal(table,'membership_v2_quote_drafts');calls.push(['table',table]);
    return {async insert(row) {
      calls.push(['insert',row.id]);
      if (insertFailure === 'before') throw Error('private database connection');
      if (insertFailure === 'definite') return {error:{code:'23514',message:'private constraint detail'}};
      if (insertFailure === 'sql_throw') {const error=Error('private SQL detail');error.code='42501';throw error;}
      if (rows.has(row.id)) return {error:{message:'duplicate private data'}};
      rows.set(row.id,structuredClone(row));
      if (insertFailure === 'after') throw Error('lost acknowledgement, private detail');
      return {error:null};
    },select(columns) {
      const filters={};const query={eq(key,value) {filters[key]=value;return query;},is(key,value) {filters[key]=value;return query;},async maybeSingle() {
        calls.push(['read',filters.id,filters.scope_id]);
        if (readFailure) throw Error('secret database detail');
        const row = rows.get(filters.id);return {data:row && Object.entries(filters).every(([key,value])=>row[key]===value) ? structuredClone(row) : null,error:null};
      }};return query;
    }};
  }};
  let authCalls=0;
  const service=createMembershipQuoteDraftService({db,authorizeScope:async subject=>{
    calls.push(['authorize',++authCalls,subject]);return authorize ? authorize(authCalls,subject) : auth;
  },now:clock || (()=>instant),newId,catalog,agreement});
  return {service,rows,calls,setClock:value=>instant=value};
}
function isCode(code,status) {return error=>error.code === code && (!status || error.status === status);}
function rehash(row,change) {
  const doc=JSON.parse(row.canonical_quote);change(doc);
  const stable=value=>value && typeof value === 'object' ? (Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`) : JSON.stringify(value);
  row.offer_snapshot=doc.offer;row.canonical_quote=stable(doc);
  row.quote_digest=crypto.createHash('sha256').update(row.canonical_quote).digest('hex');
}
test('missing trusted authorization/DB cannot instantiate the service',()=>{
  assert.throws(()=>createMembershipQuoteDraftService(),isCode('quote_service_not_configured',503));
});
test('public gets6 prepaid; sales and admin12 server-priced offers',async()=>{
  for (const audience of ['public','sales','admin']) {
    const f=fixture({auth:authorization(audience)}),offers=await f.service.listOffers({opaque:'capability'});
    assert.equal(offers.length,audience==='public'?6:12);
    assert.ok(offers.every(o=>audience !== 'public' || o.payment_option === 'prepaid'));
    assert.equal(f.calls.filter(c=>c[0]==='table').length,0);
  }
});
test('all12 quotes contain accepted catalog cents and no invented paid dates or signature',async()=>{
  for (const planKey of ['basic','pro']) for (const commitmentMonths of [3,6,12]) for (const paymentOption of ['prepaid','monthly_installments']) {
    const f=fixture(),result=await f.service.createQuote('trusted subject',{...choose,planKey,commitmentMonths,paymentOption});
    const offers=await f.service.listOffers('trusted subject');
    assert.deepEqual(result.quote.offer,offers.find(o=>o.plan_key===planKey && o.commitment_months===commitmentMonths && o.payment_option===paymentOption));
    assert.equal(result.signing_enabled,false);assert.equal(result.quote.template_status,'draft_only');
    assert.equal(result.quote.acceptance_state,'unsigned');assert.equal(result.quote.signing_source_bound,false);
    assert.equal(result.quote.template_version,TEMPLATE_VERSION);assert.equal(result.expired,false);assert.equal(result.stale,false);
    assert.equal(result.quote.original_salesperson_user_id,rep);assert.equal(result.quote.issued_at,start);
    assert.equal(Date.parse(result.quote.expires_at)-Date.parse(start),QUOTE_LIFETIME_MS);
    for (const absent of ['accepted_at','term_start_at','term_end_at','paid_at','agreement_id','purchase_intent_id']) assert.equal(absent in result.quote,false);
    assert.ok(Object.isFrozen(result.quote.offer));
    assert.equal(f.calls.filter(c=>c[0]==='insert').length,1);
  }
});
test('first-role prepay is explicit boolean and separate from platform total',async()=>{
  const f=fixture();const r=await f.service.createQuote('subject',{...choose,planKey:'pro',commitmentMonths:12,firstRolePrepaySelected:true});
  assert.equal(r.quote.offer.platform_payment_cents,650000);assert.equal(r.quote.offer.first_role_prepay.amount_cents,62900);
  assert.equal(r.quote.offer.initial_payment_cents,712900);
  await assert.rejects(f.service.createQuote('subject',{...choose,firstRolePrepaySelected:'yes'}),isCode('invalid_first_role_selection',400));
});
test('browser-supplied price, identity, audience and unknown fields are rejected before storage',async()=>{
  for (const key of ['platform_payment_cents','offer_snapshot','quote_digest','client_id','issuer_user_id','channel','audience','original_salesperson_user_id','accepted_at']) {
    const f=fixture();await assert.rejects(f.service.createQuote('subject',{...choose,[key]:'forged'}),isCode('invalid_quote_selection',400));
    assert.equal(f.calls.filter(c=>c[0]==='table').length,0);
  }
});
test('stale version and anonymous installments fail without writes',async()=>{
  const f=fixture({auth:authorization('public')});
  await assert.rejects(f.service.createQuote('subject',{...choose,paymentOption:'monthly_installments'}),isCode('public_installments_not_available',400));
  await assert.rejects(f.service.createQuote('subject',{...choose,offerVersion:'old'}),isCode('stale_offer_version',400));
  assert.equal(f.calls.filter(c=>c[0]==='table').length,0);
});
test('malformed/denied scope cannot read offers or use the DB; raw authorization errors stay private',async()=>{
  const changes=[{audience:'browser_admin'},{scope_id:''},{issuer_user_id:undefined},{client_id:client},{billing_owner_user_id:owner},
    {issuer_user_id:null},{original_salesperson_user_id:other},{audience:'public'},
    {scope_id:'10000000-0000-4000-8000-FFFFFFFFFFFF'}, {scope_id:[scope]}, {issuer_user_id:[rep]}];
  for(const changed of changes) {
    const f=fixture({auth:authorization('sales',changed)});
    await assert.rejects(f.service.listOffers('subject'),isCode('quote_scope_denied',403));
    await assert.rejects(f.service.createQuote('subject',choose),isCode('quote_scope_denied',403));
    assert.equal(f.calls.filter(c=>c[0]==='table').length,0);
  }
  const f=fixture({authorize:()=>{throw Error('private credential');}});
  await assert.rejects(f.service.listOffers('subject'),e=>e.message==='quote_scope_denied');
});
test('authorization changes/revocation are detected before insert across ALL context fields',async()=>{
  for (const change of [{scope_id:other},{issuer_user_id:other,original_salesperson_user_id:other},
    {client_id:client,billing_owner_user_id:owner},{audience:'admin'}]) {
    const f=fixture({authorize:n=>authorization('sales',n===1?{}:change)});
    await assert.rejects(f.service.createQuote('subject',choose),isCode('quote_scope_changed',403));
    assert.equal(f.calls.filter(c=>c[0]==='insert').length,0);
  }
  const f=fixture({authorize:n=>n===1?authorization():null});
  await assert.rejects(f.service.createQuote('subject',choose),isCode('quote_scope_denied',403));
  assert.equal(f.rows.size,0);
});
test('clock guards prevent issuance after expiry or with an invalid/future-overflow server clock',async()=>{
  for (const bad of ['2026-02-30T12:00:00.000Z','2026-10-11','infinity','9999-12-31T23:59:59.999Z']) {
    const f=fixture({clock:()=>bad});await assert.rejects(f.service.createQuote('subject',choose),isCode('invalid_quote_clock'));
    assert.equal(f.rows.size,0);
  }
  for (const later of ['2026-10-11T12:30:00.000Z','2026-10-11T11:59:59.999Z']) {
    let n=0;const f=fixture({clock:()=>++n===1?start:later});
    await assert.rejects(f.service.createQuote('subject',choose),isCode('quote_expired'));assert.equal(f.rows.size,0);
  }
});
test('lost INSERT acknowledgement requires matching immutable readback; no second insert',async()=>{
  const f=fixture({insertFailure:'after'});assert.equal((await f.service.createQuote('subject',choose)).quote.quote_id,quoteId);
  assert.equal(f.calls.filter(c=>c[0]==='insert').length,1);
  const g=fixture({insertFailure:'before'});await assert.rejects(g.service.createQuote('subject',choose),isCode('quote_create_unverified',503));
  const h=fixture({readFailure:true});await assert.rejects(h.service.createQuote('subject',choose),e=>e.message==='quote_store_unavailable');
});
test('collision with different stored selection holds, never returns that quote as new success',async()=>{
  const f=fixture();await f.service.createQuote('subject',choose);
  await assert.rejects(f.service.createQuote('subject',{...choose,planKey:'pro'}),isCode('quote_create_failed',503));
  assert.equal(f.rows.size,1);
});
test('scoped read never accepts a quote ID as authorization; changed issuer/owner denied',async()=>{
  const f=fixture();await f.service.createQuote('subject',choose);
  const row=f.rows.get(quoteId);row.scope_id=other;
  await assert.rejects(f.service.readQuote('subject',quoteId),isCode('quote_not_found',404));
  row.scope_id=scope;row.issuer_user_id=other;row.original_salesperson_user_id=other;
  await assert.rejects(f.service.readQuote('subject',quoteId),isCode('quote_not_found',404));
});
test('read reauthorizes and detects revocation even after scoped data was retrieved',async()=>{
  let deny=false;const f=fixture({authorize:n=>deny && n%2===1?null:authorization()});
  await f.service.createQuote('subject',choose);deny=true;
  await assert.rejects(f.service.readQuote('subject',quoteId),isCode('quote_scope_denied',403));
});
test('tampering any commercial/binding/digest field is held',async()=>{
  for (const change of [row=>row.offer_snapshot.platform_payment_cents=1,row=>row.quote_digest='a'.repeat(64),
    row=>row.template_status='approved',row=>row.expires_at='2026-10-11T12:31:00.000Z']) {
    const f=fixture();await f.service.createQuote('subject',choose);change(f.rows.get(quoteId));
    await assert.rejects(f.service.readQuote('subject',quoteId),isCode('invalid_quote_readback'));
  }
  const f=fixture();await f.service.createQuote('subject',choose);
  rehash(f.rows.get(quoteId),doc=>{doc.offer.renewal.default_auto_renew=false;});
  await assert.rejects(f.service.readQuote('subject',quoteId),isCode('invalid_quote_readback'));
});
test('expired/historical-version read retains frozen price without consulting today catalog or enabling signing',async()=>{
  const f=fixture();const initial=await f.service.createQuote('subject',choose);
  f.setClock('2026-10-11T12:30:00.000Z');const expired=await f.service.readQuote('subject',quoteId);
  assert.equal(expired.expired,true);assert.equal(expired.quote_digest,initial.quote_digest);assert.deepEqual(expired.quote,initial.quote);
  rehash(f.rows.get(quoteId),doc=>{doc.offer.offer_version='retail-historical-v1';doc.offer.platform_payment_cents=123456;
    doc.offer.platform_commitment_total_cents=123456;doc.offer.initial_payment_cents=123456;});
  const historical=await f.service.readQuote('subject',quoteId);
  assert.equal(historical.stale,true);assert.equal(historical.quote.offer.platform_payment_cents,123456);
  assert.equal(historical.signing_enabled,false);
});
test('existing scoped client/billing owner can be bound without any client/Auth mutation',async()=>{
  const f=fixture({auth:authorization('admin',{client_id:client,billing_owner_user_id:owner,original_salesperson_user_id:other})});
  const r=await f.service.createQuote('subject',choose);
  assert.equal(r.quote.client_id,client);assert.equal(r.quote.billing_owner_user_id,owner);
  assert.equal(r.quote.original_salesperson_user_id,other);
  assert.ok(f.calls.filter(c=>c[0]==='table').every(c=>c[1]==='membership_v2_quote_drafts'));
});
test('admin non-commission quote may have no rep; public cannot carry existing tenant identities',async()=>{
  const f=fixture({auth:authorization('admin',{original_salesperson_user_id:null})});
  assert.equal((await f.service.createQuote('subject',choose)).quote.original_salesperson_user_id,null);
  const g=fixture({auth:authorization('public',{client_id:client,billing_owner_user_id:owner})});
  await assert.rejects(g.service.createQuote('subject',choose),isCode('quote_scope_denied',403));
});
test('nil IDs and definite INSERT errors fail without reconciliation reads',async()=>{
  const f=fixture({newId:()=> '00000000-0000-0000-0000-000000000000'});
  await assert.rejects(f.service.createQuote('subject',choose),isCode('invalid_quote_id',503));assert.equal(f.rows.size,0);
  for(const insertFailure of ['definite','sql_throw']) {
    const g=fixture({insertFailure});
    await assert.rejects(g.service.createQuote('subject',choose),isCode('quote_create_failed',503));
    assert.equal(g.calls.filter(c=>c[0]==='read').length,0);
  }
});
test('second catalog/template resolution must match the first exactly before insert',async()=>{
  for (const change of ['money','version','template']) {
    let resolutions=0;let descriptors=0;
    const catalog={currentVersion:()=>change==='version' && resolutions>1?'next':OFFER_VERSION,
      listOffers:channel=>listRetailOffers({channel}),resolveOffer:(choice,channel)=>{
        resolutions++;const offer=structuredClone(buildRetailOffer({...choice,channel}));
        if(change==='money' && resolutions>1){offer.platform_payment_cents++;offer.platform_commitment_total_cents++;offer.initial_payment_cents++;}
        return offer;
      }};
    const f=fixture({catalog,agreement:()=>({version:TEMPLATE_VERSION,publication:change==='template' && ++descriptors>1?'published':'draft_only'})});
    await assert.rejects(f.service.createQuote('subject',choose),isCode(change==='money'?'quote_catalog_changed':change==='version'?'stale_offer_version':'quote_template_unavailable'));
    assert.equal(f.rows.size,0);
  }
});
test('duplicate offer projections and wrong selection resolution fail closed',async()=>{
  const catalog={currentVersion:()=>OFFER_VERSION,listOffers:channel=>Array.from({length:12},()=>buildRetailOffer({...choose,channel})),
    resolveOffer:(choice,channel)=>buildRetailOffer({...choice,planKey:'pro',channel})};
  const f=fixture({catalog});await assert.rejects(f.service.listOffers('subject'),isCode('quote_catalog_unavailable',503));
  await assert.rejects(f.service.createQuote('subject',choose),isCode('quote_selection_conflict'));assert.equal(f.rows.size,0);
});
test('no existing route imports the unwired draft service',()=>{
  const fs=require('node:fs'),path=require('node:path');
  function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);if(entry.isDirectory())walk(file);
    else if(file.endsWith('.js'))assert.equal(fs.readFileSync(file,'utf8').includes('membershipQuoteDrafts'),false,file);
  }}
  walk(path.join(__dirname,'../src/routes'));
});
