'use strict';
const {createCanvas}=require('@napi-rs/canvas'),zlib=require('node:zlib');
const magic=Buffer.from([137,80,78,71,13,10,26,10]);
function crc(b){let r=0xffffffff;for(const n of b){r^=n;for(let j=0;j<8;j++)r=(r&1)?(r>>>1)^0xedb88320:r>>>1;}return (r^0xffffffff)>>>0;}
function chunk(t,b){const r=Buffer.alloc(b.length+12);r.writeUInt32BE(b.length);r.write(t,4);b.copy(r,8);r.writeUInt32BE(crc(r.subarray(4,-4)),r.length-4);return r;}
function dataUrl(b){return 'data:image/png;base64,'+b.toString('base64');}
function signature(){const c=createCanvas(300,100),x=c.getContext('2d');x.strokeStyle='#101b4d';x.lineWidth=3;x.beginPath();
  x.moveTo(30,70);x.lineTo(80,20);x.lineTo(140,80);x.lineTo(260,30);x.stroke();return c.toDataURL('image/png');}
function png({width=2,height=2,filter=0,pixels=Buffer.from([20,30,40,255,80,90,100,255,40,50,60,255,100,110,120,255]),extra=[],rawChange}={}){
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const stride=4*width,raw=Buffer.alloc((stride+1)*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb && pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){raw[y*(stride+1)]=filter;for(let x=0;x<stride;x++){
    const at=y*stride+x,a=x>=4?pixels[at-4]||0:0,b=y>0?pixels[at-stride]||0:0,c=y>0 && x>=4?pixels[at-stride-4]||0:0;
    const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
    raw[y*(stride+1)+1+x]=((pixels[at]||0)-predictor+256)%256;
  }}
  const compressed=zlib.deflateSync(rawChange?rawChange(raw):raw);
  return Buffer.concat([magic,chunk('IHDR',header),...extra,chunk('IDAT',compressed),chunk('IEND',Buffer.alloc(0))]);
}
module.exports={signature,png,chunk,dataUrl,magic};
