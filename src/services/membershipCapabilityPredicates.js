'use strict';
// Shared exact input grammar; no configured client, sender or environment.
const EMAIL=/^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function validMembershipBuyerEmail(v){return typeof v==='string' && v.length<=254 && EMAIL.test(v) && !/\.\.|\.@/.test(v);}
function validIssuedMembershipVersion(v){return typeof v==='string' && /^retail-membership-issued-[A-Za-z0-9._-]{1,100}$/.test(v) && !/draft|review/i.test(v);}
module.exports={validMembershipBuyerEmail,validIssuedMembershipVersion};
