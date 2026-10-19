'use strict';
// Authored build fixture only. No database/provider/client records or credentials.
const assert=require('node:assert/strict');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {PDFParse}=require('pdf-parse');
const {chromium}=require('../src/render/browserRuntime');
const {htmlToPdf}=require('../src/render/pdfRenderer');
async function main(){
 assert.equal(process.env.APP_ENV,'prod');
 if(process.platform==='linux'){
  assert.equal(process.env.SUPABASE_URL,'https://rytlclkkcvvnkoncfaid.supabase.co');
  assert.equal(process.env.RENDER_SERVICE_ID,'srv-d2s94oumcj7s73abnq80');
 }
 const executable=process.platform==='linux'?await chromium.executablePath():process.env.PUPPETEER_EXECUTABLE_PATH;
 assert.ok(executable);
 const version=await promisify(execFile)(executable,['--version'],{timeout:10000});
 assert.match(version.stdout,/(?:Chrome|Chromium|HeadlessChrome).*\b153\./);
 const html='<!doctype html><html><head><style>@page{size:A4 landscape;margin:14mm}body{font:15px Arial;color:#111a4c}h1{font-size:28px}</style></head><body><h1>alphaScreen synthetic production build fixture</h1><h2>Candidate Review Brief</h2><p>Fictional candidate. Resume 84%. Interview 88%. Advanced evidence illustrative.</p><h2>Membership agreement</h2><p>Synthetic membership, three months, January 1 to April 1. No signature or payment.</p><p>No external assets, scripts, customer data or provider requests.</p></body></html>';
 const pdf=Buffer.from(await htmlToPdf(html,{landscape:true}));
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 const parser=new PDFParse({data:pdf});try{const text=(await parser.getText()).text;assert.match(text,/Candidate Review Brief/);assert.match(text,/Membership agreement/);}finally{await parser.destroy();}
 console.log(JSON.stringify({productionPdfSmoke:'PASS',version:version.stdout.trim(),bytes:pdf.length,expectedText:true,authoredFixtureOnly:true,databaseCalls:0,providerCalls:0}));
}
main().catch(error=>{console.error('production_pdf_smoke_failed:',error.message);process.exitCode=1;});
