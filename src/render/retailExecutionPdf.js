'use strict';
// Copy the immutable preview's pages; NEVER rerender its legal HTML/template.
const {PDFDocument,PDFDict,PDFArray,PDFName}=require('pdf-lib'),Handlebars=require('handlebars');
const {retailFontSupports}=require('./retailSignerFont');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fail(){const e=new Error('retail_execution_unverified');e.code='retail_execution_unverified';e.status=503;throw e;}
const assetRoot=path.join(__dirname,'../../templates');
const fonts=['Regular','Bold'].map((weight,i)=>`@font-face{font-family:Raleway;font-weight:${i?700:400};src:url(data:font/ttf;base64,${
  fs.readFileSync(path.join(assetRoot,`email-attachments/alphascreen-getting-started-playbook-source/fonts/Raleway-${weight}.ttf`)).toString('base64')}) format('truetype');}`).join('');
const logo='data:image/png;base64,'+fs.readFileSync(path.join(assetRoot,'pdf/assets/No bg - color logo - dark text.png')).toString('base64');
const body=Handlebars.compile(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>
{{{fonts}}}*{box-sizing:border-box}body{font-family:Raleway,Arial,sans-serif;color:#0a1547;font-size:10px;line-height:1.45;margin:0}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #a380f6;padding-bottom:14px;margin-bottom:18px}img.logo{width:154px}
h1{font-size:22px;margin:0 0 5px}h2{font-size:12px;margin:18px 0 8px}p{margin:4px 0 10px;overflow-wrap:anywhere}.muted{color:#65708c}
.notice{background:#f5f2fe;border:1px solid #ded5f4;border-radius:8px;padding:12px}.grid{display:grid;grid-template-columns:140px minmax(0,1fr);gap:7px 12px}.grid>div{min-width:0;overflow-wrap:anywhere}.label{font-weight:700}
.hash{font-family:monospace;font-size:9px;overflow-wrap:anywhere}.signature{border:1px solid #d9deeb;border-radius:8px;padding:14px;margin-top:8px;height:124px}
.signature img{max-width:100%;max-height:94px;object-fit:contain}footer{margin-top:18px;border-top:1px solid #d9deeb;padding-top:10px;font-size:9px;color:#65708c}
</style></head><body><header><img class="logo" src="{{logo}}"><div>MEMBERSHIP AGREEMENT<br><b>Signature record</b></div></header>
<h1>Agreement signature</h1><p class="muted">This page refers to the unchanged agreement pages preceding it.</p>
<div class="notice">Acceptance is effective only when the server's immutable acceptance record is committed. Preparation time below is not an acceptance or payment time. Membership starts only after the required payment succeeds.</div>
<h2>Signer attestation</h2><p>I accept the attached membership agreement and confirm that I am authorized to sign for the company.</p>
<div class="grid"><div class="label">Typed name</div><div>{{name}}</div><div class="label">Explicit consent</div><div>Accepted</div>
<div class="label">Preparation time (UTC)</div><div>{{prepared}}</div><div class="label">Document ID</div><div class="hash">{{document}}</div>
<div class="label">Source ID</div><div class="hash">{{sourceId}}</div>
<div class="label">Attempt ID</div><div class="hash">{{attempt}}</div><div class="label">Legal version</div><div class="hash">{{legal}}</div></div>
<div class="signature"><img src="{{signature}}" alt="Drawn signature"></div>
<h2>Exact document references</h2><div class="grid"><div class="label">Source fingerprint</div><div class="hash">{{source}}</div>
<div class="label">Issued HTML SHA-256</div><div class="hash">{{htmlHash}}</div><div class="label">Preview PDF SHA-256</div><div class="hash">{{pdfHash}}</div>
<div class="label">Signature SHA-256</div><div class="hash">{{signatureHash}}</div></div>
<footer>The typed name is a signer attestation, not a change to the buyer contact or proof of a new account identity. The immutable acceptance record contains the actual acceptance timestamp and executed-file hash.</footer></body></html>`,{strict:true});
const PROFILE=Object.freeze({format:'Letter',printBackground:true,margin:Object.freeze({top:'0.6in',right:'0.6in',bottom:'0.6in',left:'0.6in'})});
function validPdf(bytes,max){return Buffer.isBuffer(bytes) && bytes.length>=16 && bytes.length<=max
  && bytes.subarray(0,5).toString()==='%PDF-' && bytes.subarray(-1024).toString('latin1').includes('%%EOF');}
function createRetailExecutionRenderer({renderAttestationPdf}={}){
  if(typeof renderAttestationPdf!=='function')fail();
  return async function render({document,previewBytes,signature,name,attemptId,preparedAt}){try{
    const preview=Buffer.from(previewBytes),image=Buffer.from(signature.bytes);
    if(!validPdf(preview,8388608) || sha(preview)!==document.preview_pdf_sha256 || preview.length!==document.preview_pdf_size
      || sha(document.rendered_html)!==document.html_sha256 || sha(image)!==signature.sha256 || !Number.isFinite(Date.parse(preparedAt)) || !retailFontSupports(name))fail();
    const receiptHtml=body({fonts,logo,name,prepared:new Date(preparedAt).toISOString(),document:document.id,sourceId:document.source_id,attempt:attemptId,
      legal:document.legal_version,signature:'data:image/png;base64,'+image.toString('base64'),source:document.source_fingerprint,
      htmlHash:document.html_sha256,pdfHash:document.preview_pdf_sha256,signatureHash:signature.sha256});
    const receipt=Buffer.from(await renderAttestationPdf(receiptHtml,PROFILE));if(!validPdf(receipt,2097152))fail();
    const options={ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true};
    const original=await PDFDocument.load(preview,options),attest=await PDFDocument.load(receipt,options);
    inspectPdf(original);inspectPdf(attest);
    if(original.getPageCount()<1 || original.getPageCount()>32 || attest.getPageCount()<1 || attest.getPageCount()>3)fail();
    const executed=await PDFDocument.create({updateMetadata:false});
    for(const p of await executed.copyPages(original,original.getPageIndices()))executed.addPage(p);
    for(const p of await executed.copyPages(attest,attest.getPageIndices()))executed.addPage(p);
    // Do not inherit or synthesize PDF Info/XMP dates. Preparation time is visible
    // text from the native session; actual accepted_at remains the SQL record.
    executed.context.trailerInfo.Info=undefined;
    inspectPdf(executed);
    const bytes=Buffer.from(await executed.save({useObjectStreams:false}));
    if(!validPdf(bytes,12582912) || bytes.length>preview.length+receipt.length+2097152)fail();
    return Object.freeze({pdf_bytes:bytes,preview_pages:original.getPageCount(),attestation_pages:attest.getPageCount(),attestation_html:receiptHtml});
  }catch(_){fail();}};
}
function inspectPdf(doc){let visited=0;const seen=new Set();
  function scan(value){if(!value || seen.has(value))return;seen.add(value);if(++visited>20000)fail();
    if(value instanceof PDFDict){for(const [key,v] of value.entries()){
      if(['JS','JavaScript','AA','OpenAction','Launch','XFA','EmbeddedFiles','EF','URI'].includes(key.decodeText()))fail();
      if(key===PDFName.of('Type') && v===PDFName.of('Filespec'))fail();
      if(key===PDFName.of('S') && ['URI','JavaScript','Launch'].some(n=>v===PDFName.of(n)))fail();
      if(key===PDFName.of('Metadata'))fail();scan(v);
    }}else if(value instanceof PDFArray)for(const v of value.asArray())scan(v);
    else if(value.dict instanceof PDFDict)scan(value.dict);
  }
  for(const [,object] of doc.context.enumerateIndirectObjects())scan(object);
}
module.exports={createRetailExecutionRenderer};
