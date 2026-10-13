'use strict';

// Adapt the existing customer portal, not Checkout, account setup or renewal
// collection. New retail terms must not inherit the account-default controls.
const {isDeepStrictEqual} = require('node:util');
const {resolveBillingOwnerForScope} = require('./clientBillingScope');
const {loadExistingRetailSubscriptionTerms} = require('./contracts/subscriptionPricingTerms');

function hold(forbidden = false) {
  return Object.assign(new Error(forbidden ? 'Retail billing access is not available.' : 'Billing portal is temporarily unavailable.'), {
    code: forbidden ? 'RETAIL_PORTAL_FORBIDDEN' : 'RETAIL_PORTAL_UNAVAILABLE', status: forbidden ? 403 : 503
  });
}
function requireFact(value) { if (!value) throw hold(); }
function modeFromKey(key) {
  if (/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key || '')) return false;
  if (/^(sk|rk)_live_[A-Za-z0-9_]+$/.test(key || '')) return true;
  throw hold();
}
function subscriptionIdentity(subscription, customerId) {
  requireFact(subscription?.object === 'subscription' && /^sub_[A-Za-z0-9_]+$/.test(subscription.id || '')
    && (typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id) === customerId
    && typeof subscription.livemode === 'boolean'
    && subscription.metadata && typeof subscription.metadata === 'object' && !Array.isArray(subscription.metadata));
  return {id:subscription.id,customer:customerId,livemode:subscription.livemode,metadata:{...subscription.metadata}};
}
async function readCustomerSubscriptions(stripe, customerId) {
  const items=[],seen=new Set();let after;
  for (let page=0;page<10;page++) {
    const response=await stripe.subscriptions.list({customer:customerId,status:'all',limit:100,
      ...(after ? {starting_after:after} : {})});
    requireFact(response?.object === 'list' && typeof response.has_more === 'boolean'
      && Array.isArray(response.data) && response.data.length <= 100);
    for (const sub of response.data) {
      const identity=subscriptionIdentity(sub,customerId);
      requireFact(!seen.has(identity.id));seen.add(identity.id);items.push(identity);
    }
    requireFact(items.length < 1000);
    if (!response.has_more) return items.sort((a,b)=>a.id.localeCompare(b.id));
    requireFact(response.data.length > 0);after=response.data.at(-1).id;
  }
  throw hold(); // Overflow is not a complete customer census.
}
async function readState({db,stripe,clientId,customerId,authorizeRetail}) {
  const scope=await resolveBillingOwnerForScope(db,clientId);
  requireFact(scope.ok && scope.billingClientId && scope.billingClient?.id === scope.billingClientId
    && scope.billingClient?.stripe_customer_id === customerId);
  const subscriptionId=scope.billingClient.stripe_subscription_id;
  const subscription=subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
  const identity=subscription ? subscriptionIdentity(subscription,customerId) : null;
  requireFact(!subscriptionId || identity?.id === subscriptionId);
  let context;
  try { context=await loadExistingRetailSubscriptionTerms({db,clientId:scope.billingClientId,subscription}); }
  catch (error) { if (scope.isChildClient) throw hold(true); throw error; }
  if (scope.isChildClient && context) throw hold(true);
  requireFact(!context?.pending);
  if (context && authorizeRetail !== true) throw hold(true);
  // A customer portal covers all customer subscriptions, not a single DB row.
  // Refuse unverified shared aliases rather than opening a default portal for
  // a second unmarked row that stores a new retail customer's id.
  const {data:owners,error,count}=await db.from('clients').select('id',{count:'exact'})
    .eq('stripe_customer_id',customerId).limit(2);
  requireFact(!error && count === 1 && Array.isArray(owners) && owners.length === 1
    && owners[0].id === clientId);
  const census=await readCustomerSubscriptions(stripe,customerId);
  requireFact(!identity || census.some(sub=>isDeepStrictEqual(sub,identity)));
  requireFact(census.every(sub=>sub.metadata.membership_pricing_version == null || sub.id === subscriptionId));
  requireFact(!context || context.client.stripe_customer_id === customerId
    && context.client.stripe_subscription_id === subscriptionId);
  return {scope,context,identity,census};
}
function assertConfiguration(config, configurationId, livemode) {
  requireFact(config?.object === 'billing_portal.configuration' && config.id === configurationId
    && config.active === true && config.is_default === false && config.application === null
    && config.livemode === livemode && config.login_page?.enabled === false);
  const features=config.features,allowed=['customer_update','invoice_history','payment_method_update','subscription_cancel','subscription_update'];
  requireFact(features && Object.keys(features).length === allowed.length
    && Object.keys(features).every(key=>allowed.includes(key)));
  for (const feature of allowed) requireFact(features[feature]?.enabled === ['invoice_history','payment_method_update'].includes(feature));
}
function assertSession(session,{customerId,configurationId,returnUrl,livemode,retail=true}) {
  requireFact(session?.object === 'billing_portal.session' && /^bps_[A-Za-z0-9_]+$/.test(session.id || '')
    && session.customer === customerId && session.return_url === returnUrl && session.livemode === livemode
    && session.flow === null && session.on_behalf_of === null);
  if (typeof session.configuration === 'string') requireFact(session.configuration === configurationId);
  else if (retail) assertConfiguration(session.configuration,configurationId,livemode);
  else requireFact(session.configuration?.object === 'billing_portal.configuration' && session.configuration.id === configurationId
    && session.configuration.livemode === livemode);
  let url;try { url=new URL(session.url); } catch (_) { throw hold(); }
  requireFact(url.protocol === 'https:' && url.hostname === 'billing.stripe.com' && !url.username && !url.password
    && !url.port && !url.search && !url.hash && /^\/p\/session\/[^/]+/.test(url.pathname));
}

async function createClientBillingPortalSession(options) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  try {
    const {stripe,customerId,returnUrl,configurationId,stripeKey}=options;
    const initial=await readState(options);
    if (!initial.context) {
      // True unmarked legacy/Enterprise: preserve exact existing create payload,
      // but never let a stale null classification bypass a new retail source.
      const latest=await readState(options);requireFact(isDeepStrictEqual(initial,latest));
      const session=await stripe.billingPortal.sessions.create({customer:customerId,return_url:returnUrl});
      const id=typeof session?.configuration === 'string' ? session.configuration : session?.configuration?.id;
      requireFact(/^bpc_[A-Za-z0-9_]+$/.test(id || ''));
      const livemode=modeFromKey(stripeKey), config=await stripe.billingPortal.configurations.retrieve(id);
      requireFact(config?.object === 'billing_portal.configuration' && config.id === id && config.active === true && config.livemode === livemode);
      requireFact(isDeepStrictEqual(initial,await readState(options)));
      assertSession(session,{customerId,configurationId:id,returnUrl,livemode,retail:false});
      return session;
    }
    requireFact(/^bpc_[A-Za-z0-9_]+$/.test(configurationId || ''));
    const livemode=modeFromKey(stripeKey);
    const config=await stripe.billingPortal.configurations.retrieve(configurationId);
    assertConfiguration(config,configurationId,livemode);
    const latest=await readState(options);requireFact(isDeepStrictEqual(initial,latest));
    const session=await stripe.billingPortal.sessions.create({customer:customerId,return_url:returnUrl,configuration:configurationId});
    assertSession(session,{customerId,configurationId,returnUrl,livemode});
    assertConfiguration(await stripe.billingPortal.configurations.retrieve(configurationId),configurationId,livemode);
    requireFact(isDeepStrictEqual(initial,await readState(options)));
    return session;
  } catch (error) {
    // Never return Stripe errors, IDs, access URLs or the supplied credential.
    if (error?.code === 'RETAIL_PORTAL_FORBIDDEN') throw hold(true);
    throw hold();
  }
}

module.exports = {createClientBillingPortalSession};
