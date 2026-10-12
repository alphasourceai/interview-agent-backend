'use strict';
// Fixed shipped font cmap, not OS fallback or caller-selected files/URLs.
const fs=require('node:fs'),path=require('node:path');
const maps=['Regular','Bold'].map(weight=>{
  const b=fs.readFileSync(path.join(__dirname,`../../templates/email-attachments/alphascreen-getting-started-playbook-source/fonts/Raleway-${weight}.ttf`));
  let cmap;for(let i=0;i<b.readUInt16BE(4);i++){const at=12+16*i;if(b.subarray(at,at+4).toString()==='cmap')cmap=b.readUInt32BE(at+8);}
  if(cmap===undefined)throw Error('retail_font_unavailable');const tables=[];
  for(let i=0;i<b.readUInt16BE(cmap+2);i++){
    const at=cmap+4+i*8,platform=b.readUInt16BE(at),encoding=b.readUInt16BE(at+2),offset=cmap+b.readUInt32BE(at+4);
    if(platform===0 || (platform===3 && [1,10].includes(encoding)))tables.push(offset);
  }
  return cp=>tables.some(at=>{
    const format=b.readUInt16BE(at);
    if(format===12){for(let i=0;i<b.readUInt32BE(at+12);i++){const p=at+16+12*i,start=b.readUInt32BE(p),end=b.readUInt32BE(p+4);
      if(cp>=start && cp<=end)return b.readUInt32BE(p+8)+cp-start!==0;}return false;}
    if(format!==4 || cp>65535)return false;const n=b.readUInt16BE(at+6)/2,endAt=at+14,startAt=endAt+2*n+2,deltaAt=startAt+2*n,rangeAt=deltaAt+2*n;
    for(let i=0;i<n;i++)if(cp>=b.readUInt16BE(startAt+2*i) && cp<=b.readUInt16BE(endAt+2*i)){
      const delta=b.readInt16BE(deltaAt+2*i),range=b.readUInt16BE(rangeAt+2*i);
      if(range===0)return ((cp+delta)&65535)!==0;
      const glyph=b.readUInt16BE(rangeAt+2*i+range+2*(cp-b.readUInt16BE(startAt+2*i)));
      return glyph!==0 && ((glyph+delta)&65535)!==0;
    }return false;
  });
});
module.exports={retailFontSupports:text=>[...text].every(c=>maps.every(has=>has(c.codePointAt(0))))};
