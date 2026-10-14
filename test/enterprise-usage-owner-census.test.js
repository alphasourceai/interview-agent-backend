'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readAllPages, CODE} = require('../src/services/enterpriseUsageOwnerCensus');
const key = n => `id_${String(n).padStart(6, '0')}`;
const rows = (n, offset = 0, column = 'id') => Array.from({length:n}, (_, i) => ({[column]:key(i + offset)}));
function paged(total, { column = 'id', change = r => r } = {}) {
  const ranges=[];
  const build = () => ({range(from,to) {
    ranges.push([from,to]);
    return Promise.resolve(change({data:rows(Math.min(500, Math.max(0,total-from)),from,column),error:null,count:total}, ranges.length));
  }});
  return {build,ranges};
}
async function denied(build, options) {
  assert.deepEqual(await readAllPages(build, options), {rows:null,error:{message:CODE}});
}
for (const size of [0,1,499,500,501,1000,1200,100000]) test(`exact ordered census ${size} completes without an extra empty probe`, async () => {
  const f=paged(size);const result=await readAllPages(f.build);
  assert.equal(result.error,null);assert.equal(result.rows.length,size);
  assert.equal(f.ranges.length,Math.max(1,Math.ceil(size/500)));
  assert.deepEqual(f.ranges[0],[0,499]);
});
test('client_id keys are raw, not trimmed or coerced',async()=>{
  const f=paged(501,{column:'client_id'});assert.equal((await readAllPages(f.build,{key:'client_id'})).rows.length,501);
  const original=[{client_id:' a '},{client_id:'b'}];
  const result=await readAllPages(()=>({range:async()=>({data:original,error:null,count:2})}),{key:'client_id'});
  assert.equal(result.rows[0].client_id,' a ');
});
for(const size of [100001,100500,Number.MAX_SAFE_INTEGER])test(`count ${size} exceeds capacity before reading or returning a prefix`,async()=>{
  const f=paged(size);await denied(f.build);assert.equal(f.ranges.length,1);
});
for(const [name,mutate] of [
  ['missing count',r=>{delete r.count;}],['null count',r=>{r.count=null;}],['text count',r=>{r.count='1';}],
  ['negative count',r=>{r.count=-1;}],['fractional count',r=>{r.count=0.5;}],['unsafe count',r=>{r.count=Number.MAX_SAFE_INTEGER+1;}],
  ['null data',r=>{r.data=null;}],['nonarray data',r=>{r.data={};}],['oversized batch',r=>{r.data=rows(501);r.count=501;}],
  ['count below rows',r=>{r.count=0;}],['short incomplete batch',r=>{r.count=2;}],['null row',r=>{r.data=[null];}],
  ['array row',r=>{r.data=[[]];}],['missing key',r=>{r.data=[{}];}],['null key',r=>{r.data=[{id:null}];}],
  ['numeric key',r=>{r.data=[{id:0}];}],['empty key',r=>{r.data=[{id:''}];}],['blank key',r=>{r.data=[{id:' \t'}];}],
  ['SDK error',r=>{r.error={message:'secret-token-must-not-escape'};}]
])test(`census ${name} is sanitized unavailable with no partial rows`,async()=>{
  const f=paged(1,{change:r=>{mutate(r);return r;}});await denied(f.build);
});
for(const [name,change]of[
  ['count change',(r,p)=>{if(p===2)r.count++;return r;}],
  ['same-page duplicate',(r)=>{r.data[1]=r.data[0];return r;}],
  ['out-of-order',(r)=>{[r.data[0],r.data[1]]=[r.data[1],r.data[0]];return r;}],
  ['cross-page duplicate',(r,p)=>{if(p===2)r.data[0].id=key(499);return r;}],
  ['nonprogress page',(r,p)=>{if(p===2)r.data=rows(500);return r;}],
  ['short later page',(r,p)=>{if(p===2)r.data.pop();return r;}],
  ['later blank key',(r,p)=>{if(p===2)r.data[0].id=' ';return r;}]
])test(`census ${name} never repairs/sorts/deduplicates into success`,async()=>{
  await denied(paged(1000,{change}).build);
});
test('query construction, range call and awaited SDK throws are all sanitized',async()=>{
  await denied(()=>{throw Error('secret construction');});
  await denied(()=>({range(){throw Error('secret range');}}));
  await denied(()=>({range:async()=>{throw Error('secret await');}}));
  await denied(()=>({range:async()=>null}));
});
