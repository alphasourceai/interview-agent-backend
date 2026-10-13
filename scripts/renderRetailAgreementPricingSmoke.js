'use strict';

// Synthetic local artifacts only. Existing PDF renderer owns an isolated fresh
// browser profile, disables JS and blocks external requests in development.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const {htmlToPdf}=require('../src/render/pdfRenderer');

async function main(){
  if(process.env.APP_ENV!=='development')throw Error('synthetic_dev_pdf_mode_required');
  const out=path.resolve(process.argv[2]||'tmp/pdfs/retail-agreement-pricing');
  fs.mkdirSync(out,{recursive:true});
  const generatedAt='2026-10-12T12:00:00.000Z';
  const party={client_legal_name:'[SYNTHETIC] Harbor Maple Demo LLC',primary_admin_name:'Synthetic Buyer',
    admin_email:'synthetic@example.invalid',term_start_basis:'successful_payment',auto_renew:true};
  const variants=[
    {name:'essential-3-month-prepaid-role',snapshot:buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',
      firstRolePrepaySelected:true,channel:'sales',offerVersion:OFFER_VERSION})},
    {name:'pro-6-month-installments',snapshot:buildRetailPackageSnapshot({planKey:'pro',commitmentMonths:6,paymentOption:'monthly_installments',
      firstRolePrepaySelected:false,channel:'sales',offerVersion:OFFER_VERSION})},
    {name:'legacy-essential-monthly',snapshot:null}
  ];
  const manifest=[];
  for(const variant of variants){
    const {html}=buildMembershipAgreementHtml(variant.snapshot?party:{...party,membership_tier:'basic',billing_option:'monthly',
      platform_fee:299,per_role_fee:399,included_interviews_per_role:20,max_interview_minutes:10,additional_interview_fee:25},
      {generatedAt,timeZone:'UTC',showPackageTerms:true,...(variant.snapshot?{packageSnapshot:variant.snapshot}:{})});
    const htmlPath=path.join(out,`${variant.name}.html`),pdfPath=path.join(out,`${variant.name}.pdf`);
    fs.writeFileSync(htmlPath,html);fs.writeFileSync(pdfPath,await htmlToPdf(html));
    const prefix=path.join(out,variant.name);
    execFileSync('pdftoppm',['-scale-to','1600','-png',pdfPath,prefix]);
    const info=execFileSync('pdfinfo',[pdfPath],{encoding:'utf8'});
    const pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);if(!pages)throw Error('synthetic_pdf_pages_unverified');
    manifest.push({name:variant.name,pdf:pdfPath,html:htmlPath,pages});
  }
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(manifest,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
