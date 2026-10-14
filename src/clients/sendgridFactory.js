'use strict';
const guard = require('../config/guardedPricingDev');

function guardCall(target, key) {
  return (...args) => {
    if(guard.isGuardedPricingDev()&&['send','sendMultiple'].includes(key)&&guard.isDevPricingTestMail()){
      const {ownerMailRecipients,assertOwnerOnlyMail}=require('../config/devPricingTestMail');
      assertOwnerOnlyMail(args[0],ownerMailRecipients(process.env.DEV_PRICING_EMAIL_RECIPIENTS));
      if(!guard.isDevPricingTestMail())throw guard.hold();
    }else guard.assertGuardedDevOutboundAllowed();
    return target[key](...args);
  };
}
module.exports = function sendgridFactory() {
  const mail = require('@sendgrid/mail');
  return new Proxy(mail, { get(target, key) {
    if (key === 'send' || key === 'sendMultiple') return guardCall(target, key);
    if (key === 'client' && target.client) return new Proxy(target.client, { get(client, member) {
      if (member === 'request') return guardCall(client, member);
      const value = client[member];
      return typeof value === 'function' ? value.bind(client) : value;
    } });
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
};
