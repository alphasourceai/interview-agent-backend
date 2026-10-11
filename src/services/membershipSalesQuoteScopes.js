'use strict';

// UNMOUNTED manual sales-only authorization. No public/admin/GHL/existing-client
// fallback, Auth creation, verified buyer, signature or checkout. Tokens stay
// inside the injected Auth client call; do not log subjects or raw DB errors.
const crypto=require('node:crypto');
const TABLE='membership_v2_sales_quote_scopes';
const COLUMNS='id,issuer_user_id,audience,scope_kind,source_verified,idempotency_key_hash,request_fingerprint,created_at';
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
const fingerprint=actor=>hash(`manual-prospect-scope-v1\n${actor}\nsales\nmanual_prospect`);
const keyConstraint='membership_v2_sales_scopes_actor_key_unique';
const keyConflict=error=>error?.code==='23505' && (error.constraint===keyConstraint
  || error.message===`duplicate key value violates unique constraint "${keyConstraint}"`);
const definite=error=>typeof error?.code==='string' && (/^[0-9A-Z]{5}$/.test(error.code)||error.code.startsWith('PGRST'));
function fail(code,status=403){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function plain(value,keys){return value && typeof value==='object' && !Array.isArray(value)
  && [Object.prototype,null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).every(key=>keys.includes(key));}
function context(row){return Object.freeze({scope_id:row.id,audience:'sales',issuer_user_id:row.issuer_user_id,
  original_salesperson_user_id:row.issuer_user_id,client_id:null,billing_owner_user_id:null});}

function createMembershipSalesQuoteScopeService({db,auth,now=()=>Date.now()}={}){
  check(typeof db?.from==='function' && typeof db.rpc==='function' && typeof auth?.getUser==='function'
    && typeof now==='function','sales_scope_not_configured',503);
  function clock(){const value=now();check(Number.isSafeInteger(value),'sales_scope_clock_unavailable',503);return value;}
  async function authenticate(subject){
    check(plain(subject,['accessToken','scopeId']) && Object.hasOwn(subject,'accessToken') && typeof subject.accessToken==='string'
      && subject.accessToken.length>0 && subject.accessToken.length<=8192
      && !/\s/.test(subject.accessToken),'sales_scope_denied');
    let result;
    try{result=await auth.getUser(subject.accessToken);}catch(_){fail('sales_scope_denied');}
    const user=result?.data?.user,instant=clock();
    check(!result?.error && user && typeof user.id==='string' && UUID.test(user.id)
      && user.is_anonymous===false && typeof user.email==='string' && user.email.length>0
      && typeof user.email_confirmed_at==='string' && Number.isFinite(Date.parse(user.email_confirmed_at))
      && Date.parse(user.email_confirmed_at)<=instant && user.deleted_at==null
      && (user.banned_until==null || (typeof user.banned_until==='string'
        && Number.isFinite(Date.parse(user.banned_until)) && Date.parse(user.banned_until)<=instant)), 'sales_scope_denied');
    let grant;
    try{grant=await db.from('sales_reps').select('user_id,active').eq('user_id',user.id).eq('active',true).maybeSingle();}
    catch(_){fail('sales_scope_access_unavailable',503);}
    if(grant?.error)fail('sales_scope_access_unavailable',503);
    check(grant?.data?.user_id===user.id && grant.data.active===true,'sales_scope_denied');
    return user.id;
  }
  function validate(row,actor){
    check(plain(row,COLUMNS.split(',')) && Object.keys(row).length===COLUMNS.split(',').length
      && typeof row.id==='string' && UUID.test(row.id) && row.issuer_user_id===actor
      && row.audience==='sales' && row.scope_kind==='manual_prospect' && row.source_verified===false
      && typeof row.idempotency_key_hash==='string' && /^[0-9a-f]{64}$/.test(row.idempotency_key_hash)
      && row.request_fingerprint===fingerprint(actor)
      && typeof row.created_at==='string' && Number.isFinite(Date.parse(row.created_at))
      && Date.parse(row.created_at)<=clock(),'sales_scope_readback_unverified',503);
    return context(row);
  }
  async function read(actor,key,value){
    let result;
    try{result=await db.from(TABLE).select(COLUMNS).eq('issuer_user_id',actor).eq(key,value).maybeSingle();}
    catch(_){fail('sales_scope_store_unavailable',503);}
    if(result?.error)fail('sales_scope_store_unavailable',503);
    return result?.data || null;
  }
  async function authorizeScope(subject){
    const actor=await authenticate(subject);
    check(Object.hasOwn(subject,'scopeId') && typeof subject.scopeId==='string' && UUID.test(subject.scopeId),'sales_scope_denied');
    const row=await read(actor,'id',subject.scopeId);
    if(!row)fail('sales_scope_denied');
    check(row.id===subject.scopeId,'sales_scope_readback_unverified',503);
    const result=validate(row,actor);
    check(await authenticate(subject)===actor,'sales_scope_denied');
    return result;
  }
  return Object.freeze({authorizeScope,
    async createScope(subject,input){
      check(plain(input,['idempotencyKey']) && Object.hasOwn(input,'idempotencyKey') && typeof input.idempotencyKey==='string'
        && /^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey),'invalid_sales_scope_request',400);
      check(plain(subject,['accessToken']) && !Object.hasOwn(subject,'scopeId'),'sales_scope_denied');
      const actor=await authenticate(subject),keyHash=hash(`manual-prospect-idempotency-v1\n${input.idempotencyKey}`),expected=fingerprint(actor);
      let reservation;
      try{reservation=await db.rpc('membership_v2_reserve_sales_quote_scope',{
        p_actor:actor,p_key_hash:keyHash,p_fingerprint:expected});}
      catch(error){
        if(!keyConflict(error) && definite(error))
          fail('sales_scope_create_failed',503);
        // Unknown transport outcome: exactly one actor/key read below, no retry.
      }
      if(reservation?.error){
        if(reservation.error.code==='P0001' && reservation.error.message==='sales_scope_denied')fail('sales_scope_denied');
        if(reservation.error.code==='P0001' && reservation.error.message==='sales_scope_conflict')fail('sales_scope_conflict',409);
        if(!keyConflict(reservation.error) && definite(reservation.error))fail('sales_scope_create_failed',503);
        reservation=undefined; // Unknown returned transport outcome or named actor/key uniqueness only.
      }
      if(reservation){
        check(Array.isArray(reservation.data) && reservation.data.length===1,'sales_scope_create_unverified',503);
        validate(reservation.data[0],actor);
        check(reservation.data[0].idempotency_key_hash===keyHash,'sales_scope_create_unverified',503);
      }
      check(await authenticate(subject)===actor,'sales_scope_denied');
      const row=await read(actor,'idempotency_key_hash',keyHash);
      check(row && row.idempotency_key_hash===keyHash,'sales_scope_create_unverified',503);
      if(reservation)check(row.id===reservation.data[0].id,'sales_scope_create_unverified',503);
      const result=validate(row,actor);
      check(await authenticate(subject)===actor,'sales_scope_denied');
      return result;
    }
  });
}
module.exports={createMembershipSalesQuoteScopeService};
