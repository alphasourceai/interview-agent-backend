'use strict';
// Authenticated-loader-shaped SYNTHETIC data only. Not hosted Auth/DB evidence.
const crypto=require('node:crypto');
const {buildRetailOffer,OFFER_VERSION}=require('../../src/services/membershipOffers');
const {TEMPLATE_VERSION}=require('../../src/services/membershipQuoteDrafts');
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const sourceId='10000000-0000-4000-8000-000000000001',scopeId='10000000-0000-4000-8000-000000000002';
const rep='10000000-0000-4000-8000-000000000003',quoteId='10000000-0000-4000-8000-000000000004';
function fixture(selection={},buyerChange={}){
  const offer=buildRetailOffer({channel:'sales',planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION,...selection});
  const quote={schema_version:2,protocol:'retail_quote_draft_v2',quote_id:quoteId,scope_id:scopeId,audience:'sales',issuer_user_id:rep,
    original_salesperson_user_id:rep,client_id:null,billing_owner_user_id:null,acceptance_state:'unsigned',signing_source_bound:false,
    offer,template_version:TEMPLATE_VERSION,template_status:'draft_only',issued_at:'2026-10-11T12:00:00.000Z',expires_at:'2026-10-11T12:30:00.000Z'};
  const quoteDigest=sha(canonical(quote));
  const source={protocol:'retail_sales_prospect_v2',source_version:1,source_id:sourceId,scope_id:scopeId,issuer_user_id:rep,
    original_salesperson_user_id:rep,quote_id:quoteId,quote_digest:quoteDigest,previous_source_id:null,acceptance_state:'unsigned',
    buyer:{company_legal_name:'Cedar Vale Demo LLC (Synthetic)',company_dba:null,buyer_first_name:'Demo',buyer_last_name:'Buyer',
      buyer_email:'buyer@example.invalid',buyer_phone:'+12025550123',buyer_title:'Operations Director',...buyerChange}};
  const sourceReply={source,source_fingerprint:sha(canonical(source)),email_verified:false,verified_at:null,signing_enabled:false,checkout_enabled:false};
  const quoteReply={quote,quote_digest:quoteDigest,expired:false,stale:false,signing_enabled:false};
  function rehash(){quoteReply.quote_digest=sha(canonical(quoteReply.quote));sourceReply.source.quote_digest=quoteReply.quote_digest;
    sourceReply.source_fingerprint=sha(canonical(sourceReply.source));}
  return {sourceId,sourceReply,quoteReply,rehash};
}
module.exports={fixture,canonical,sha};
