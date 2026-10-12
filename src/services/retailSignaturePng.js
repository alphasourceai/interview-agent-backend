'use strict';
// Isolated browser-canvas PNG decoder. No configured provider/native codec.
const zlib=require('node:zlib'),crypto=require('node:crypto');
const PREFIX='data:image/png;base64,',MAX_BYTES=2097152,MAX_PIXELS=1048576;
const MAGIC=Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let n=0xffffffff;for(const b of bytes)n=CRC_TABLE[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function fail(){const e=new Error('signature_invalid');e.code='signature_invalid';e.status=400;throw e;}
function check(v){if(!v)fail();}
function chunk(type,data){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4,4,'ascii');data.copy(out,8);
  out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;}
function paeth(a,b,c){const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db && da<=dc?a:db<=dc?b:c;}
function parseRetailSignature(raw){try{
  check(typeof raw==='string' && raw.startsWith(PREFIX) && raw.length<=MAX_BYTES);
  const base64=raw.slice(PREFIX.length);check(base64.length>0 && base64.length%4===0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64));
  const bytes=Buffer.from(base64,'base64');check(bytes.length>=57 && bytes.length<=MAX_BYTES && bytes.toString('base64')===base64 && bytes.subarray(0,8).equals(MAGIC));
  let offset=8,width=0,height=0,header=null,ended=false;const compressed=[],seen=new Set();
  while(offset<bytes.length){
    check(offset+12<=bytes.length);const length=bytes.readUInt32BE(offset),end=offset+12+length;check(end<=bytes.length);
    const type=bytes.subarray(offset+4,offset+8).toString('ascii'),data=bytes.subarray(offset+8,end-4);
    check(crc(bytes.subarray(offset+4,end-4))===bytes.readUInt32BE(end-4));
    if(type==='IHDR'){
      check(offset===8 && !header && length===13);header=Buffer.from(data);width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      check(width>0 && width<=2048 && height>0 && height<=1024 && width*height<=MAX_PIXELS
        && data[8]===8 && data[9]===6 && data[10]===0 && data[11]===0 && data[12]===0);
    }else if(type==='IDAT'){check(header && length>0);compressed.push(data);}
    else if(type==='IEND'){check(header && compressed.length>0 && length===0 && end===bytes.length);ended=true;offset=end;break;}
    else {
      check(header && compressed.length===0 && !seen.has(type) && ['sRGB','gAMA','cHRM','pHYs','sBIT','bKGD'].includes(type));seen.add(type);
      check((type==='sRGB' && length===1 && data[0]<=3) || (type==='gAMA' && length===4 && data.readUInt32BE(0)>0)
        || (type==='cHRM' && length===32) || (type==='pHYs' && length===9 && data[8]<=1)
        || (type==='sBIT' && length===4 && [...data].every(v=>v>=1 && v<=8))
        || (type==='bKGD' && length===6 && [0,2,4].every(i=>data.readUInt16BE(i)<=255)));
    }
    offset=end;
  }
  check(ended && offset===bytes.length);
  const stride=width*4,expected=(stride+1)*height,input=Buffer.concat(compressed);
  const inflated=zlib.inflateSync(input,{maxOutputLength:expected,info:true});
  check(inflated.buffer.length===expected && inflated.engine.bytesWritten===input.length);
  const pixels=Buffer.alloc(stride*height);let ink=false;
  for(let y=0;y<height;y++){
    const start=y*(stride+1),filter=inflated.buffer[start];check(filter<=4);
    for(let x=0;x<stride;x++){
      const at=y*stride+x,a=x>=4?pixels[at-4]:0,b=y>0?pixels[at-stride]:0,c=y>0 && x>=4?pixels[at-stride-4]:0;
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
      pixels[at]=(inflated.buffer[start+1+x]+predictor)&255;
      if(x%4===3 && pixels[at]>=32 && Math.max(pixels[at-3],pixels[at-2],pixels[at-1])<=230)ink=true;
    }
  }
  check(ink);
  const plain=Buffer.alloc(expected);for(let y=0;y<height;y++)pixels.copy(plain,y*(stride+1)+1,y*stride,(y+1)*stride);
  const canonical=Buffer.concat([MAGIC,chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(plain,{level:9,memLevel:8,strategy:zlib.constants.Z_DEFAULT_STRATEGY})),chunk('IEND',Buffer.alloc(0))]);
  check(canonical.length<=MAX_BYTES);
  const dimensions=Buffer.alloc(8);dimensions.writeUInt32BE(width);dimensions.writeUInt32BE(height,4);
  return Object.freeze({bytes:canonical,width,height,sha256:crypto.createHash('sha256').update(canonical).digest('hex'),
    pixels_sha256:crypto.createHash('sha256').update('retail-signature-rgba-v1\n','utf8').update(dimensions).update(pixels).digest('hex'),
    dataUrl:PREFIX+canonical.toString('base64'),contentType:'image/png'});
}catch(_){fail();}}
module.exports={parseRetailSignature};
