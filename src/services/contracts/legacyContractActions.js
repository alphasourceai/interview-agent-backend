'use strict';
// Internal original-scanner DB seam. No provider effects or missing-RPC fallback.
const {snapshotStripeSdkData}=require('../enterprisePoolPaymentProof');
const KEYS='contract_start_at,contract_end_at,auto_renew,manual_active_override,billing_status,subscription_status,stripe_subscription_id,stripe_customer_id,cancel_at_term_end,cancel_effective_at,plan_tier,billing_interval,parent_client_id,archived_at'.split(',');
const BOOL=new Set(['auto_renew','manual_active_override','cancel_at_term_end']);
const DATES=new Set(['contract_start_at','contract_end_at','cancel_effective_at','archived_at']);
const shape=o=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===['id',...KEYS].sort().join(',');
function project(client){return Object.fromEntries(KEYS.map(k=>[k,client[k]??null]));}
function valid(o){return shape(o)&&KEYS.every(k=>o[k]===null||(BOOL.has(k)?typeof o[k]==='boolean':typeof o[k]==='string'&&(!DATES.has(k)||Number.isFinite(Date.parse(o[k])))));}
async function legacyContractAction(db,client,action){
 try{
  const r=await db.rpc('apply_legacy_contract_action',{p_client:client.id,p_expected:project(client),p_action:action});
  if(!r||r.error)throw Error();
  const d=snapshotStripeSdkData(r.data);
  if(!d||Object.keys(d).sort().join(',')!=='client,status'||!['applied','unchanged','changed','held','permitted'].includes(d.status))throw Error();
  if(d.client!==null&&(!valid(d.client)||d.client.id!==client.id))throw Error();
  if(['applied','unchanged','permitted'].includes(d.status)&&!d.client)throw Error();
  if(d.status==='permitted'&&action!=='check_cancel'||d.status==='applied'&&action==='check_cancel')throw Error();
  return{data:JSON.parse(JSON.stringify(d)),error:null};
 }catch(_){return{data:null,error:{message:'legacy_contract_action_unavailable'}};}
}
module.exports={legacyContractAction};
