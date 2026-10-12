'use strict';
// UNMOUNTED private account preparation ONLY. No sending, invitation/link,
// confirmation/password/session/metadata/client/access/commission effect.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto'), { isProxy } = require('node:util').types;
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const canonical = v => v && typeof v==='object' ? (Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`) : JSON.stringify(v);
const same = (a,b) => canonical(a) === canonical(b);
function held() { const e = new Error('membership_account_setup_held'); e.code = e.message; e.status = 409; throw e; }
const check = v => { if (!v) held(); };
function exact(v,keys) { if (!v || typeof v !== 'object' || isProxy(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) return false;
  const d=Object.getOwnPropertyDescriptors(v);return Reflect.ownKeys(d).length===keys.length && keys.every(k=>d[k]?.enumerable && Object.hasOwn(d[k],'value')); }
const timestamp = v => typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
function createMembershipAccountProvision({db,projectUrl,adminKey,environment,contextId,fetchImplementation=globalThis.fetch}={}) {
  check(typeof projectUrl==='string' && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)
    && db?.supabaseUrl===projectUrl && typeof db.rpc==='function' && typeof adminKey==='string' && adminKey.length<=4096
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(adminKey)
    && ['dev','qa','production'].includes(environment) && UUID.test(contextId||'') && typeof fetchImplementation==='function');
  let keyClaims;try{keyClaims=JSON.parse(Buffer.from(adminKey.split('.')[1],'base64url').toString('utf8'));}catch(_){held();}
  check(keyClaims?.role==='service_role' && keyClaims.iss==='supabase' && keyClaims.ref===new URL(projectUrl).hostname.split('.')[0]);
  const keyHash=sha(adminKey);
  // Each request gets its OWN closure, not a shared mutable SDK POST allowance.
  function sdk(target,postAllowed) {
    let posts=0,gets=0;
    return createClient(projectUrl,adminKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,init)=>{
      const h=new Headers(init.headers);check(h.get('apikey')===adminKey && h.get('authorization')===`Bearer ${adminKey}`);
      if(init.method==='POST') {
        check(postAllowed && posts++===0 && String(url)===`${projectUrl}/auth/v1/admin/users`);
        let b;try{b=JSON.parse(init.body);}catch(_){held();}
        check(exact(b,['id','email','email_confirm']) && b.id===target.request_user_id && b.email===target.email && b.email_confirm===false);
      } else check(init.method==='GET' && !init.body && gets++===0 && String(url)===`${projectUrl}/auth/v1/admin/users/${target.request_user_id}`);
      return fetchImplementation(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
    }}}).auth.admin;
  }
  const args=(id,action,nonce=null,user=null)=>({p_operation:id,p_context:contextId,p_project:projectUrl,p_environment:environment,
    p_key_hash:keyHash,p_action:action,p_nonce:nonce,p_user:user});
  async function rpc(a) {check(db.supabaseUrl===projectUrl);const r=await db.rpc('membership_v2_account_provision',a);check(r&&!r.error);return r.data;}
  function context(c,id) {const o=c?.operation;check(o?.operation_id===id && o.context_id===contextId && UUID.test(o.request_user_id||'')
    && typeof o.email==='string' && ['new','existing_signin','existing_verification'].includes(o.kind)
    && c.project_url===projectUrl && c.environment===environment && c.admin_key_sha256===keyHash
    && o.ownership_verified===false && o.access_enabled===false && o.email_enabled===false);return c;}
  function proof(u,o) {check(u?.id===o.request_user_id && typeof u.email==='string' && timestamp(u.created_at)
    && (u.email_confirmed_at==null||timestamp(u.email_confirmed_at)) && u.role==='authenticated' && u.aud==='authenticated'
    && u.is_anonymous===false && (u.is_sso_user===false || u.is_sso_user===undefined));
    const e=u.email.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g,'').replace(/[A-Z]/g,c=>c.toLowerCase());check(e===o.email);
    // Native proof timestamp uses six fractions. Preserve microseconds, pad
    // shorter UTC fractions; reject alternate offsets rather than round them.
    const stamp=v=>{check(v.endsWith('Z'));const m=v.match(/^(.*:\d{2})(?:\.(\d{1,6}))?Z$/);check(m);return `${m[1]}.${(m[2]||'').padEnd(6,'0')}Z`;};
    return {user_id:u.id,email:e,created_at:stamp(u.created_at),confirmed_at:u.email_confirmed_at==null?null:stamp(u.email_confirmed_at),
      role:u.role,aud:u.aud,anonymous:false,sso:false};
  }
  async function prepare(input) {let id=null,stage='preflight_held';try {
    check(exact(input,['operationId']) && typeof input.operationId==='string' && UUID.test(input.operationId));
    id=input.operationId;
    let reserved;try{reserved=await db.rpc('membership_v2_account_provision',args(id,'reserve'));}catch(_){/* one native read below */}
    let c=context(await rpc(args(id,'read')),id);const o=c.operation;
    if(reserved&&!reserved.error) check(reserved.data?.operation?.request_user_id===o.request_user_id);
    if(o.kind==='new' && !c.dispatch) {
      const nonce=crypto.randomBytes(32).toString('base64url');let ack;
      stage='dispatch_ack_unknown';
      try{ack=await db.rpc('membership_v2_account_provision',args(id,'dispatch',nonce));}catch(_){/* unknown ACK never permits POST */}
      c=context(await rpc(args(id,'read')),id);
      check(ack&&!ack.error && ack.data?.won===true && ack.data.operation_id===id && ack.data.nonce_hash===sha(nonce)
        && c.dispatch?.nonce_hash===sha(nonce) && c.current_user===null && c.binding===null);
      // Last native pre-effect read already checks gate, original source/money,
      // target/email absence and owned marker. No SQL lock held during network.
      stage='creation_readback_held';
      try{await sdk(o,true).createUser({id:o.request_user_id,email:o.email,email_confirm:false});}catch(_){/* recover ONLY exact UUID */}
    }
    // Marker without user => hold; NEVER a second create or a re-keyed account.
    stage='creation_readback_held';
    const r=await sdk(o,false).getUserById(o.request_user_id);check(!r.error && r.data?.user);
    stage='identity_held';
    const p=proof(r.data.user,o);
    c=context(await rpc(args(id,'read')),id);check(same(c.current_user,p));
    if(!c.binding) {
      stage='binding_readback_held';
      let ack;try{ack=await db.rpc('membership_v2_account_provision',args(id,'bind',null,p));}catch(_){/* one native read, no repeated insert */}
      c=context(await rpc(args(id,'read')),id);check(c.binding?.user_id===p.user_id && same(c.binding.proof,p));
      if(ack&&!ack.error) check(ack.data?.binding?.proof_digest===c.binding.proof_digest);
    }
    check(c.binding?.user_id===o.request_user_id && c.binding.ownership_verified===false && c.binding.access_enabled===false && c.binding.email_enabled===false);
    return Object.freeze({operationId:id,state:p.confirmed_at?'existing_signin_required':o.kind==='new'?'new_account_prepared':'existing_verification_required',
      accountOwnershipVerified:false,activationEnabled:false,emailSent:false,commissionEnabled:false,collectionEnabled:false});
  }catch(_){
    // Best-effort append-only audit, closed reason codes only. A failed/unknown
    // audit ACK is NOT retried; no reconciliation/Auth write API exists here.
    if(id){try{await db.rpc('membership_v2_account_provision',args(id,'hold',stage));}catch(_){/* opaque hold stays */}}
    held();}}
  return Object.freeze({prepare});
}
module.exports={createMembershipAccountProvision};
