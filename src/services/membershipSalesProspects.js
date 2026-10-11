'use strict';

// UNMOUNTED. Contact proof only: never signing, buyer Auth identity or access.
// handoffVerification is a trusted SERVER callback, not a browser response. No
// default mail client. Delivery ledger/rate limits remain required before mount.
const crypto=require('node:crypto');
const {createMembershipQuoteDraftService}=require('./membershipQuoteDrafts');
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES='membership_v2_sales_prospects',HEADS='membership_v2_sales_prospect_heads';
const CHALLENGES='membership_v2_sales_email_challenges',PROOFS='membership_v2_sales_email_proofs';
const COLUMNS='id,scope_id,issuer_user_id,quote_id,quote_digest,previous_source_id,protocol,source_version,buyer_snapshot,canonical_source,source_fingerprint,created_at';
const BUYER_KEYS=['company_legal_name','company_dba','buyer_first_name','buyer_last_name','buyer_email','buyer_phone','buyer_title'];
const LIMITS={company_legal_name:160,company_dba:160,buyer_first_name:80,buyer_last_name:80,buyer_email:254,buyer_phone:16,buyer_title:120};
const hash=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
const tokenHash=(id,token)=>hash(`sales-email-link-v1\n${id}\n${token}`);
const definite=error=>typeof error?.code==='string' && (/^[0-9A-Z]{5}$/.test(error.code)||error.code.startsWith('PGRST'));
function fail(code,status=403){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function plain(v,keys){return v && typeof v==='object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Object.keys(v).every(k=>keys.includes(k));}
function canonical(v){if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  return v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);}
function frozen(v){if(v && typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
function buyer(input){
  check(plain(input,BUYER_KEYS),'invalid_sales_buyer',400);const result={};
  for(const key of BUYER_KEYS){let value=input[key];
    if(['company_dba','buyer_phone','buyer_title'].includes(key) && (value==null || value===''))value=null;
    else {check(typeof value==='string','invalid_sales_buyer',400);value=value.trim();
      if(key==='buyer_email')value=value.toLowerCase();
      check(value.length>0 && [...value].length<=LIMITS[key] && !/[\p{Cc}\p{Cs}<>]/u.test(value),'invalid_sales_buyer',400);}
    result[key]=value;
  }
  check(/^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(result.buyer_email)
    && !/\.\.|\.@/.test(result.buyer_email)
    && (result.buyer_phone===null || /^\+[1-9][0-9]{7,14}$/.test(result.buyer_phone)),'invalid_sales_buyer',400);
  return frozen(result);
}
function document(row){return {protocol:'retail_sales_prospect_v2',source_version:1,source_id:row.id,
  scope_id:row.scope_id,issuer_user_id:row.issuer_user_id,original_salesperson_user_id:row.issuer_user_id,
  quote_id:row.quote_id,quote_digest:row.quote_digest,previous_source_id:row.previous_source_id,
  buyer:row.buyer_snapshot,acceptance_state:'unsigned'};}
function scope(row){return {scope_id:row.scope_id,audience:'sales',issuer_user_id:row.issuer_user_id,
  original_salesperson_user_id:row.issuer_user_id,client_id:null,billing_owner_user_id:null};}

function createMembershipSalesProspectService({db,authorizeScope,handoffVerification,catalog,now=()=>Date.now()}={}){
  check(typeof db?.from==='function' && typeof db.rpc==='function' && typeof authorizeScope==='function'
    && typeof handoffVerification==='function' && typeof now==='function','sales_prospect_not_configured',503);
  function clock(){const value=now();check(Number.isSafeInteger(value),'sales_prospect_clock_unavailable',503);return value;}
  async function one(table,columns,filters){let result;
    try{let q=db.from(table).select(columns);for(const [k,v] of Object.entries(filters))q=v===null?q.is(k,null):q.eq(k,v);
      result=await q.maybeSingle();}catch(_){fail('sales_prospect_store_unavailable',503);}
    if(result?.error)fail('sales_prospect_store_unavailable',503);return result?.data || null;
  }
  async function authorize(subject){let ctx;try{ctx=await authorizeScope(subject);}catch(_){fail('sales_prospect_denied');}
    check(plain(ctx,['scope_id','audience','issuer_user_id','original_salesperson_user_id','client_id','billing_owner_user_id'])
      && Object.keys(ctx).length===6 && UUID.test(ctx.scope_id) && UUID.test(ctx.issuer_user_id) && ctx.audience==='sales'
      && ctx.issuer_user_id===ctx.original_salesperson_user_id && ctx.client_id===null && ctx.billing_owner_user_id===null,'sales_prospect_denied');
    return ctx;
  }
  function validate(row,ctx){
    check(plain(row,COLUMNS.split(',')) && Object.keys(row).length===COLUMNS.split(',').length
      && UUID.test(row.id) && row.scope_id===ctx.scope_id && row.issuer_user_id===ctx.issuer_user_id
      && UUID.test(row.quote_id) && (row.previous_source_id===null || UUID.test(row.previous_source_id))
      && row.protocol==='retail_sales_prospect_v2' && row.source_version===1
      && /^[0-9a-f]{64}$/.test(row.quote_digest) && /^[0-9a-f]{64}$/.test(row.source_fingerprint)
      && typeof row.created_at==='string' && Number.isFinite(Date.parse(row.created_at))
      && Date.parse(row.created_at)<=clock(),'sales_prospect_unverified',503);
    check(canonical(buyer(row.buyer_snapshot))===canonical(row.buyer_snapshot)
      && row.canonical_source===canonical(document(row)) && hash(row.canonical_source)===row.source_fingerprint,'sales_prospect_unverified',503);
    return row;
  }
  async function currentRow(id,ctx){const row=await one(SOURCES,COLUMNS,{id,scope_id:ctx.scope_id,issuer_user_id:ctx.issuer_user_id});
    check(row,'sales_prospect_denied');validate(row,ctx);
    const head=await one(HEADS,'scope_id,current_source_id',{scope_id:ctx.scope_id,current_source_id:id});
    check(head?.scope_id===ctx.scope_id && head.current_source_id===id,'sales_prospect_denied');return row;}
  async function quoteFor(row,ctx,subject){
    const quoteService=createMembershipQuoteDraftService({db,authorizeScope:async()=>{
      if(subject){const fresh=await authorize(subject);check(canonical(fresh)===canonical(ctx),'sales_prospect_denied');return fresh;}
      const grant=await one('sales_reps','user_id,active',{user_id:ctx.issuer_user_id,active:true});
      const owner=await one('membership_v2_sales_quote_scopes','id,issuer_user_id',{id:ctx.scope_id,issuer_user_id:ctx.issuer_user_id});
      check(grant?.user_id===ctx.issuer_user_id && grant.active===true && owner?.id===ctx.scope_id && owner.issuer_user_id===ctx.issuer_user_id,'sales_prospect_denied');return ctx;
    },catalog,now:()=>new Date(clock()).toISOString()});
    const result=await quoteService.readQuote(subject,row.quote_id);
    check(result.quote_digest===row.quote_digest && !result.expired && !result.stale,'sales_prospect_denied');return result;
  }
  function response(row,proof){return frozen({source:document(row),source_fingerprint:row.source_fingerprint,
    email_verified:Boolean(proof),verified_at:proof?.verified_at || null,signing_enabled:false,checkout_enabled:false});}
  async function proofFor(row,hashFilter){const filters={source_id:row.id};if(hashFilter)filters.token_hash=hashFilter;
    const proof=await one(PROOFS,'source_id,token_hash,verified_at,method',filters);if(!proof)return null;
    const challenge=await one(CHALLENGES,'source_id,source_fingerprint,token_hash,issued_at,expires_at,method',{source_id:row.id,token_hash:proof.token_hash});
    check(proof.source_id===row.id && proof.method==='email_link_v1' && /^[0-9a-f]{64}$/.test(proof.token_hash)
      && challenge?.source_id===row.id && challenge.source_fingerprint===row.source_fingerprint && challenge.token_hash===proof.token_hash
      && challenge.method==='email_link_v1' && Number.isFinite(Date.parse(challenge.issued_at))
      && Number.isFinite(Date.parse(challenge.expires_at)) && Number.isFinite(Date.parse(proof.verified_at))
      && Date.parse(proof.verified_at)>=Date.parse(challenge.issued_at) && Date.parse(proof.verified_at)<Date.parse(challenge.expires_at)
      && Date.parse(proof.verified_at)<=clock(),'sales_prospect_unverified',503);return proof;
  }
  return Object.freeze({
    async createProspect(subject,input){
      check(plain(input,['quoteId','expectedSourceId','buyer']) && Object.hasOwn(input,'quoteId') && Object.hasOwn(input,'buyer') && UUID.test(input.quoteId)
        && Object.hasOwn(input,'expectedSourceId') && (input.expectedSourceId===null || UUID.test(input.expectedSourceId)),'invalid_sales_prospect',400);
      const ctx=await authorize(subject),snapshot=buyer(input.buyer);
      const quoteService=createMembershipQuoteDraftService({db,authorizeScope:authorize,catalog,now:()=>new Date(clock()).toISOString()});
      const quote=await quoteService.readQuote(subject,input.quoteId);
      check(!quote.expired && !quote.stale,'sales_prospect_denied');
      const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url'),hashed=tokenHash(id,token);
      const row={id,scope_id:ctx.scope_id,issuer_user_id:ctx.issuer_user_id,quote_id:input.quoteId,
        quote_digest:quote.quote_digest,previous_source_id:input.expectedSourceId,buyer_snapshot:snapshot};
      const bytes=canonical(document(row)),fingerprint=hash(bytes);
      check(canonical(await authorize(subject))===canonical(ctx),'sales_prospect_denied');
      let ack,unknown=false;
      try{ack=await db.rpc('membership_v2_register_sales_prospect',{p_id:id,p_actor:ctx.issuer_user_id,p_scope:ctx.scope_id,
        p_quote:row.quote_id,p_quote_digest:row.quote_digest,p_previous:row.previous_source_id,p_buyer:snapshot,
        p_canonical:bytes,p_fingerprint:fingerprint,p_token_hash:hashed});}
      catch(error){if(definite(error))fail('sales_prospect_create_failed',503);unknown=true;}
      if(ack?.error){if(ack.error.code==='P0001' && ack.error.message==='sales_source_conflict')fail('sales_prospect_conflict',409);
        if(ack.error.code==='P0001' && ack.error.message==='sales_source_denied')fail('sales_prospect_denied');
        if(definite(ack.error))fail('sales_prospect_create_failed',503);unknown=true;}
      if(!unknown)check(Array.isArray(ack?.data) && ack.data.length===1 && ack.data[0].id===id,'sales_prospect_create_unverified',503);
      check(canonical(await authorize(subject))===canonical(ctx),'sales_prospect_denied');
      const stored=await currentRow(id,ctx);check(stored.canonical_source===bytes && stored.source_fingerprint===fingerprint,'sales_prospect_create_unverified',503);
      await quoteFor(stored,ctx,subject);
      const challenge=await one(CHALLENGES,'source_id,source_fingerprint,token_hash,issued_at,expires_at,method',{source_id:id,token_hash:hashed});
      check(challenge?.source_id===id && challenge.source_fingerprint===fingerprint && challenge.token_hash===hashed
        && challenge.method==='email_link_v1' && Number.isFinite(Date.parse(challenge.issued_at))
        && Date.parse(challenge.issued_at)<=clock() && Date.parse(challenge.expires_at)>clock()
        && Date.parse(challenge.expires_at)-Date.parse(challenge.issued_at)<=600000,'sales_prospect_create_unverified',503);
      await currentRow(id,ctx);check(canonical(await authorize(subject))===canonical(ctx),'sales_prospect_denied');
      // No resend on lost commit: recovery verifies persistence, not delivery.
      // A fresh quote + explicit CAS replacement can safely issue another link.
      let handoff='held_unknown_commit';
      if(!unknown){try{await handoffVerification(frozen({sourceId:id,sourceFingerprint:fingerprint,
        buyer:snapshot,token,expiresAt:challenge.expires_at}));handoff='attempted';}catch(_){handoff='failed';}}
      return frozen({...response(stored,null),verification_handoff:handoff});
    },
    async readProspect(subject,id){check(UUID.test(id),'sales_prospect_denied');const ctx=await authorize(subject);
      const row=await currentRow(id,ctx);await quoteFor(row,ctx,subject);const proof=await proofFor(row);
      await currentRow(id,ctx);check(canonical(await authorize(subject))===canonical(ctx),'sales_prospect_denied');return response(row,proof);},
    async verifyEmail(input){
      check(plain(input,['sourceId','token']) && UUID.test(input.sourceId) && typeof input.token==='string'
        && /^[A-Za-z0-9_-]{43}$/.test(input.token),'sales_email_denied');
      try{const row=await one(SOURCES,COLUMNS,{id:input.sourceId});check(row,'sales_email_denied');
        const ctx=scope(row);validate(row,ctx);await currentRow(row.id,ctx);await quoteFor(row,ctx);
        const hashed=tokenHash(row.id,input.token);let ack;
        try{ack=await db.rpc('membership_v2_verify_sales_email',{p_source:row.id,p_token_hash:hashed});}
        catch(error){if(definite(error))fail('sales_email_denied');}
        if(ack?.error && definite(ack.error))fail('sales_email_denied');
        const proof=await proofFor(row,hashed);check(proof,'sales_email_denied');
        const challenge=await one(CHALLENGES,'expires_at',{source_id:row.id,token_hash:hashed});
        check(Date.parse(challenge?.expires_at)>clock(),'sales_email_denied');
        await currentRow(row.id,ctx);await quoteFor(row,ctx);return response(row,proof);
      }catch(_){fail('sales_email_denied');}
    }
  });
}
module.exports={createMembershipSalesProspectService};
