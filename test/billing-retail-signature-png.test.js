'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),{loadImage,createCanvas}=require('@napi-rs/canvas');
const {parseRetailSignature}=require('../src/services/retailSignaturePng');
const {signature,png,chunk,dataUrl,magic}=require('./fixtures/retail-signature');
test('native canvas signature decodes/reencodes and strips sBIT/sRGB; independent native pixels preserved',async()=>{
  const input=signature(),p=parseRetailSignature(input),a=await loadImage(Buffer.from(input.split(',')[1],'base64')),b=await loadImage(p.bytes);
  const pixels=image=>{const c=createCanvas(image.width,image.height),x=c.getContext('2d');x.drawImage(image,0,0);return [...x.getImageData(0,0,image.width,image.height).data];};
  assert.deepEqual(pixels(a),pixels(b));assert.equal(p.width,300);assert.equal(p.height,100);
  assert.equal(p.bytes.includes(Buffer.from('sBIT')),false);assert.equal(p.bytes.includes(Buffer.from('sRGB')),false);
  assert.equal(parseRetailSignature(p.dataUrl).sha256,p.sha256);assert.equal(parseRetailSignature(p.dataUrl).pixels_sha256,p.pixels_sha256);
});
test('all five PNG filters give same independently decoded pixel identity and canonical bytes',()=>{
  const parsed=[0,1,2,3,4].map(filter=>parseRetailSignature(dataUrl(png({filter}))));
  assert.equal(new Set(parsed.map(p=>p.pixels_sha256)).size,1);assert.equal(new Set(parsed.map(p=>p.sha256)).size,1);
});
test('strict MIME/base64, byte cap, corruption/truncation/trailing content are rejected',()=>{
  const valid=dataUrl(png());for(const value of [null,'',valid.replace('image/png','image/jpeg'),valid+'=',valid+'\n',valid.replace(';base64,',';base64, '),
    dataUrl(Buffer.concat([png(),Buffer.from('extra')])),dataUrl(png().subarray(0,-1)),dataUrl(Buffer.from('not a png')),'x'.repeat(2097153)])
    assert.throws(()=>parseRetailSignature(value),e=>e.code==='signature_invalid');
  const bad=png();bad[bad.length-1]^=1;assert.throws(()=>parseRetailSignature(dataUrl(bad)),e=>e.code==='signature_invalid');
});
test('unknown, compressed/text, animation and duplicate header chunks held even with valid CRC',()=>{
  for(const t of ['iCCP','tEXt','zTXt','iTXt','acTL','fcTL','fdAT','ABCD','IHDR'])
    assert.throws(()=>parseRetailSignature(dataUrl(png({extra:[chunk(t,Buffer.from('x'))]}))),e=>e.code==='signature_invalid');
});
test('dimension limits checked before inflate; wrong filter/overflow/underflow held',()=>{
  const base=png(),header=Buffer.from(base.subarray(16,29));header.writeUInt32BE(0xffffffff);
  const large=Buffer.concat([magic,chunk('IHDR',header),base.subarray(33)]);
  for(const b of [large,png({rawChange:r=>{r[0]=5;return r;}}),png({rawChange:r=>Buffer.concat([r,Buffer.from([0])])}),png({rawChange:r=>r.subarray(0,-1)})])
    assert.throws(()=>parseRetailSignature(dataUrl(b)),e=>e.code==='signature_invalid');
});
test('every compressed IDAT byte must be consumed; trailing compressed stream or garbage held',()=>{
  const base=png();for(const extra of [Buffer.from([1,2,3]),require('node:zlib').deflateSync(Buffer.from('extra'))]){
    let o=8;const parts=[magic];while(o<base.length){const n=base.readUInt32BE(o),type=base.subarray(o+4,o+8).toString(),data=base.subarray(o+8,o+8+n);
      parts.push(chunk(type,type==='IDAT'?Buffer.concat([data,extra]):data));o+=n+12;}
    assert.throws(()=>parseRetailSignature(dataUrl(Buffer.concat(parts))),e=>e.code==='signature_invalid');
  }
});
test('transparent/white/too-low-alpha samples are blank; stated dark RGBA threshold accepted',()=>{
  for(const rgba of [[0,0,0,0],[255,255,255,255],[20,20,20,31],[231,20,20,255]])
    assert.throws(()=>parseRetailSignature(dataUrl(png({width:1,height:1,pixels:Buffer.from(rgba)}))),e=>e.code==='signature_invalid');
  assert.equal(parseRetailSignature(dataUrl(png({width:1,height:1,pixels:Buffer.from([230,230,230,32])}))).width,1);
});
