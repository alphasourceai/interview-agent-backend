'use strict';

// Prospective, UNWIRED server adapter. No route, provider mutation, client
// activation, access grant, renewal alignment, delivery or imported credentials.
// authorizeBillingOwner is a trusted server callback, NEVER a browser boolean.
// The injected SDK must use our pinned Stripe API2023-10-16 and its own account.
const { planFirstMembershipActivation } = require('./membershipPaymentActivation');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => typeof value === 'string' ? value : value?.id;
const nativeId = (value,prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
function fail(code,status=409) { const error=new Error(code); error.code=code; error.status=status; throw error; }
function requireValue(condition,code,status) { if (!condition) fail(code,status); }
async function one(query) {
  let result;
  try { result=await query.maybeSingle(); } catch { fail('membership_store_read_failed',503); }
  if (result.error) fail('membership_store_read_failed',503);
  return result.data;
}
function sameScope(left,right) {
  return ['contractId','contractVersion','clientId','billingOwnerUserId'].every(key=>left[key]===right[key]);
}
function validScope(scope) {
  return scope && ['contractId','clientId','billingOwnerUserId'].every(key=>UUID.test(scope[key] || ''))
    && Number.isSafeInteger(scope.contractVersion) && scope.contractVersion>0;
}
async function authorize(callback,contractId) {
  requireValue(typeof callback==='function','membership_authorization_required',403);
  let scope;
  try { scope=await callback({contractId}); } catch { fail('membership_authorization_unavailable',503); }
  requireValue(validScope(scope) && scope.contractId===contractId,'membership_scope_denied',403);
  return Object.freeze({...scope});
}
async function providerRead(operation) {
  try { return await operation(); } catch { fail('membership_provider_read_failed',503); }
}

async function reserveFirstMembershipPayment({db,stripe,contractId,authorizeBillingOwner,
  observedAt=()=>Math.floor(Date.now()/1000)}={}) {
  requireValue(UUID.test(contractId || ''),'invalid_membership_contract',400);
  const scope=await authorize(authorizeBillingOwner,contractId);
  requireValue(db && typeof db.from==='function' && typeof db.rpc==='function','membership_store_unavailable',503);
  requireValue(stripe && typeof stripe.getApiField==='function'
    && stripe.getApiField('version')==='2023-10-16','membership_stripe_version_unverified',503);
  const contract=await one(db.from('membership_v2_contracts').select('*').eq('id',scope.contractId)
    .eq('contract_version',scope.contractVersion).eq('client_id',scope.clientId).eq('billing_owner_user_id',scope.billingOwnerUserId));
  requireValue(contract && contract.id===scope.contractId && contract.contract_version===scope.contractVersion
    && contract.client_id===scope.clientId && contract.billing_owner_user_id===scope.billingOwnerUserId,
  'membership_scope_denied',403);
  const storedBinding=await one(db.from('membership_v2_provider_bindings').select('*')
    .eq('contract_id',contract.id).eq('contract_version',contract.contract_version));
  requireValue(storedBinding && storedBinding.contract_id===contract.id && storedBinding.contract_version===contract.contract_version
    && nativeId(storedBinding.provider_account_id,'acct') && typeof storedBinding.livemode==='boolean'
    && nativeId(storedBinding.checkout_session_id,'cs') && nativeId(storedBinding.subscription_id,'sub')
    && nativeId(storedBinding.customer_id,'cus') && nativeId(storedBinding.platform_price_id,'price')
    && nativeId(storedBinding.platform_item_id,'si'),'membership_binding_missing');
  const previous=await one(db.from('membership_v2_initial_receipts').select('identity')
    .eq('contract_id',contract.id).eq('contract_version',contract.contract_version));

  // Obtain identity from the authenticated account itself, not event metadata,
  // the request's Connect header, a claimed account ID or an expanded payload.
  const account=await providerRead(()=>stripe.accounts.retrieve());
  requireValue(account?.object==='account' && account.id===storedBinding.provider_account_id,
    'membership_provider_account_conflict');
  const checkout=await providerRead(()=>stripe.checkout.sessions.retrieve(storedBinding.checkout_session_id));
  requireValue(nativeId(id(checkout?.invoice),'in'),'membership_initial_invoice_missing');
  const subscription=await providerRead(()=>stripe.subscriptions.retrieve(storedBinding.subscription_id));
  const items=await providerRead(()=>stripe.subscriptionItems.list({subscription:storedBinding.subscription_id,limit:100,expand:['data.price']}));
  const invoice=await providerRead(()=>stripe.invoices.retrieve(id(checkout.invoice)));
  const lines=await providerRead(()=>stripe.invoices.listLineItems(id(checkout.invoice),{limit:100,expand:['data.price']}));
  requireValue(nativeId(id(invoice?.payment_intent),'pi'),'membership_initial_payment_missing');
  const paymentIntent=await providerRead(()=>stripe.paymentIntents.retrieve(id(invoice.payment_intent)));
  requireValue(nativeId(id(paymentIntent?.latest_charge),'ch'),'membership_initial_charge_missing');
  const charge=await providerRead(()=>stripe.charges.retrieve(id(paymentIntent.latest_charge)));
  const refunds=await providerRead(()=>stripe.refunds.list({charge:id(paymentIntent.latest_charge),limit:100}));
  // Non-complete lists hold: never silently activate from a truncated page.
  const input={binding:{contractId:contract.id,contractVersion:contract.contract_version,offer:contract.offer_snapshot,
    livemode:storedBinding.livemode,checkoutSessionId:storedBinding.checkout_session_id,customerId:storedBinding.customer_id,
    subscriptionId:storedBinding.subscription_id,platformPriceId:storedBinding.platform_price_id,
    platformItemId:storedBinding.platform_item_id,firstRolePriceId:storedBinding.first_role_price_id},
  checkout,subscription:{...subscription,items},invoice:{...invoice,lines},paymentIntent,charge:{...charge,refunds},
  observedAt:observedAt(),existingActivation:previous?.identity};
  const plan=planFirstMembershipActivation(input);
  const proof=plan.action==='already_activated' ? plan.identity : plan.activation;
  const platformLine=lines.data.find(line=>id(line.subscription_item)===storedBinding.platform_item_id);
  requireValue(nativeId(platformLine?.id,'il'),'membership_initial_platform_line_missing');
  // Recheck authorization after provider I/O and before the database mutation.
  const freshScope=await authorize(authorizeBillingOwner,contractId);
  requireValue(sameScope(scope,freshScope),'membership_scope_changed',403);
  let result;
  try { result=await db.rpc('membership_v2_reserve_initial_payment',{
    p_contract_id:contract.id,p_contract_version:contract.contract_version,p_client_id:scope.clientId,
    p_billing_owner_user_id:scope.billingOwnerUserId,p_provider_account_id:account.id,
    p_receipt:{...proof,platform_line_id:platformLine.id}
  }); } catch { fail('membership_payment_reservation_failed',503); }
  if (result.error) {
    fail(result.error.code==='23505' ? 'membership_receipt_owner_conflict' : 'membership_payment_reservation_failed',
      result.error.code==='23505' ? 409 : 503);
  }
  requireValue(['initial_payment_reserved','already_reserved'].includes(result.data?.action),
    'membership_payment_reservation_unverified',503);
  const persisted=await one(db.from('membership_v2_initial_receipts').select('identity')
    .eq('contract_id',contract.id).eq('contract_version',contract.contract_version));
  const identity=persisted?.identity;
  requireValue(identity && identity.provider_account_id===account.id && identity.platform_line_id===platformLine.id
    && ['contract_id','contract_version','offer_version','checkout_session_id','customer_id','subscription_id',
      'invoice_id','payment_intent_id','charge_id','platform_price_id','platform_item_id',
      'first_role_price_id','livemode','currency','payment_success_at'].every(key=>identity[key]===proof[key]),
  'membership_payment_reservation_unverified',503);
  // This is receipt reservation, NOT live activation. The provider billing
  // anchor still requires its separately reviewed alignment/readback executor.
  return Object.freeze({action:result.data.action,contractId:contract.id,
    paymentIdentity:Object.freeze({...identity}),providerAlignmentRequired:true});
}

module.exports={reserveFirstMembershipPayment};
