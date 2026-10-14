'use strict';

// Pricing-only adapter for the existing subscription lifecycle. Read accepted
// agreement terms from our DB; provider metadata is never a price authority.
const { readRetailPackageOffer } = require('../membershipPackageCompatibility');
const { getRetailRenewalWindow } = require('./contractRenewals');
const {STRIPE_RECURRING_OFFER_VERSION}=require('../membershipOffers');
const TEMPLATE = 'membership_agreement_retail_terms_v2';
function mismatch() { const e = new Error('retail_subscription_terms_mismatch'); e.code=e.message; throw e; }
const id = value => typeof value === 'string' ? value : value?.id;

async function loadExistingRetailSubscriptionTerms({db, clientId, subscription} = {}) {
  const {data:client,error:clientError} = await db.from('clients')
    .select('id,plan_tier,billing_interval,contract_start_at,contract_end_at,auto_renew,cancel_at_term_end,cancel_effective_at,stripe_customer_id,stripe_subscription_id,billing_status')
    .eq('id',clientId).maybeSingle();
  if(clientError) throw new Error(clientError.message || 'retail_subscription_client_read_failed');
  const {data:agreement,error} = await db.from('membership_agreements')
    .select('id,client_id,status,is_current,checkout_status,checkout_paid_at,membership_tier,billing_option,template_version,template_snapshot,superseded_by_agreement_id')
    .eq('client_id',clientId).eq('is_current',true).maybeSingle();
  if(error) throw new Error(error.message || 'retail_subscription_agreement_read_failed');
  const pkg=agreement?.template_snapshot?.package_snapshot;
  const offer=readRetailPackageOffer(pkg);
  if(!offer) {
    if(client?.billing_interval==='prepaid' || agreement?.billing_option==='prepaid' || agreement?.template_version===TEMPLATE
      || agreement?.template_snapshot?.template_version===TEMPLATE
      || subscription?.metadata?.membership_pricing_version != null) mismatch();
    return null;
  }
  if(agreement.client_id!==clientId || agreement.is_current!==true
    || !(agreement.status==='signed'||offer.offer_version===STRIPE_RECURRING_OFFER_VERSION&&agreement.status==='active')
    || agreement.superseded_by_agreement_id || agreement.template_version!==TEMPLATE
    || agreement.template_snapshot.template_version!==TEMPLATE
    || agreement.membership_tier!==offer.plan_key
    || agreement.billing_option!==(offer.payment_option==='prepaid'?'prepaid':'monthly')) mismatch();
  // Generic events cannot activate an unpaid new agreement. Existing paid
  // Checkout/initial-invoice activation owns that transition and account setup.
  if(agreement.checkout_status!=='paid') return {pending:true};
  if(!client || !client.stripe_customer_id || !client.stripe_subscription_id || typeof client.auto_renew!=='boolean') mismatch();
  getRetailRenewalWindow(client,agreement); // Validate the current original-anchored window, not today's catalog.
  return {pending:false,client,agreementId:agreement.id,offer,packageSnapshot:pkg};
}

function assertExistingRetailSubscription(context, subscription) {
  if(!context || context.pending) mismatch();
  const {client,offer}=context, items=subscription?.items;
  if(subscription?.object!=='subscription' || subscription.id!==client.stripe_subscription_id
    || id(subscription.customer)!==client.stripe_customer_id || subscription.currency!=='usd'
    || !['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'].includes(subscription.status)
    || items?.object!=='list' || items.has_more!==false || !Array.isArray(items.data) || items.data.length!==1) mismatch();
  const item=items.data[0],price=item?.price;
  if(item.quantity!==1 || id(item.subscription)!==subscription.id
    || price?.object!=='price' || price.type!=='recurring' || price.currency!=='usd'
    || price.unit_amount!==offer.platform_payment_cents || price.recurring?.interval!=='month'
    || price.recurring.interval_count!==offer.stripe_recurrence.interval_count
    || price.recurring.usage_type!=='licensed') mismatch();
}

module.exports = { loadExistingRetailSubscriptionTerms, assertExistingRetailSubscription };
