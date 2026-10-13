'use strict';
// TEST PROCESS ONLY. Never imported by app.js or production code.
// A broken provider double must fail before a socket, not hit a real vendor.
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
function deny() { throw Object.assign(new Error('Test network is restricted to loopback.'), { code: 'TEST_EXTERNAL_NETWORK_REFUSED' }); }
function check(host) { if (!allowed.has(String(host || 'localhost').toLowerCase())) deny(); }
function socketArgs(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path && !first.host && !first.hostname && !first.servername) return;
    check(first.host || first.hostname || first.servername);
  } else if (typeof first === 'number') check(typeof args[1] === 'string' ? args[1] : 'localhost');
  else if (typeof first === 'string' && first.startsWith('/')) return;
  else deny();
}
for (const [target, key] of [[net,'connect'],[net,'createConnection'],[tls,'connect']]) {
  const original = target[key];
  target[key] = function(...args) { socketArgs(args); return original.apply(this,args); };
}
function httpArgs(args) {
  const first=args[0];
  if(typeof first === 'string' || first instanceof URL) check(new URL(first).hostname);
  else check(first?.hostname || first?.host);
}
for(const target of [http,https]) for(const key of ['request','get']) {
  const original=target[key];
  target[key]=function(...args){httpArgs(args);return original.apply(this,args);};
}
const originalFetch=global.fetch;
global.fetch=function(input,...args){check(new URL(typeof input==='string'||input instanceof URL?input:input.url).hostname);return originalFetch.call(this,input,...args);};
