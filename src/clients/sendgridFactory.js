'use strict';
const { assertGuardedDevOutboundAllowed } = require('../config/guardedPricingDev');

function guardCall(target, key) {
  return (...args) => {
    assertGuardedDevOutboundAllowed();
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
