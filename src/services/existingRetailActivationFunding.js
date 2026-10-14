'use strict';
// Existing webhook proof chooser, not a second activation/Auth/billing flow.
const {readSavedRetailCheckoutTerms}=require('./savedMembershipCheckoutTerms');
const {readExistingRetailCheckoutFunding}=require('./existingRetailCheckoutFunding');
const {recordExistingRetailFunding}=require('./existingRetailFundingReceipt');
const {readExistingRetailFundingReceipt}=require('./existingRetailFundingReplay');
function fail(code){const e=Error(code);e.code=code;e.status=503;throw e;}
async function readExistingRetailActivationFunding(options){
 const {db,agreementId,assertFence=async()=>{}}=options;
 await assertFence();
 let ar,ir;try{
  ar=await db.from('membership_agreements').select('*').eq('id',agreementId).maybeSingle();
  ir=await db.from('public_purchase_intents').select('*').eq('agreement_id',agreementId).maybeSingle();
 }catch(_){fail('retail_activation_funding_source_unknown');}
 if(!ar||!ir||ar.error||ir.error)fail('retail_activation_funding_source_unknown');
 const a=ar.data,i=ir.data;
 // Keep existing terminal/legacy protocol behavior, and never enroll an old
 // paid cohort into newly invented raw provider-period evidence.
 if(i?.status==='canceled'||i?.canceled_at||i?.protocol==='legacy_complete'||a?.superseded_by_agreement_id
  ||!readSavedRetailCheckoutTerms({agreement:a,intent:i,deadlineMode:'stored'}))return readExistingRetailCheckoutFunding(options);
 if(a.retail_funding_receipt)return(await readExistingRetailFundingReceipt(options)).funding;
 if(a.checkout_paid_at||i?.activated_at)return readExistingRetailCheckoutFunding(options);
 // Only the trusted SDK/native writer can establish first funding. Unknown or
 // lost acknowledgment fails this attempt; next delivery reads its receipt.
 const result=await recordExistingRetailFunding(options);
 if(!result?.funding)fail('retail_activation_funding_source_changed');return result.funding;
}
module.exports={readExistingRetailActivationFunding};
