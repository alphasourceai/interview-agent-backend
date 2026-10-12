'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),{PDFDocument,PDFName,PDFString}=require('pdf-lib');
const {createRetailExecutionRenderer}=require('../src/render/retailExecutionPdf'),{parseRetailSignature}=require('../src/services/retailSignaturePng');
const {signature}=require('./fixtures/retail-signature'),{sha}=require('./fixtures/retail-review-fixture');
async function pdf(pages=2,mutate){const d=await PDFDocument.create({updateMetadata:false});for(let i=0;i<pages;i++)d.addPage([612,792]).drawText(`SYNTHETIC PAGE ${i+1}`);
  d.setCreationDate(new Date('2001-01-01T00:00:00Z'));if(mutate)mutate(d);return Buffer.from(await d.save({useObjectStreams:false}));}
function input(preview){return {document:{id:'10000000-0000-4000-8000-000000000001',source_id:'10000000-0000-4000-8000-000000000002',
  source_fingerprint:sha('SYNTHETIC SOURCE'),legal_version:'retail-membership-issued-synthetic-v1',rendered_html:'SYNTHETIC HTML',html_sha256:sha('SYNTHETIC HTML'),
  preview_pdf_sha256:sha(preview),preview_pdf_size:preview.length},previewBytes:preview,signature:parseRetailSignature(signature()),
  name:'Zoë López',attemptId:'10000000-0000-4000-8000-000000000003',preparedAt:'2026-10-11T12:00:00Z'};}
test('copy preserves original page count/order/size, appends receipt only and drops host PDF Info',async()=>{
  const original=await pdf(),receipt=await pdf(1),render=createRetailExecutionRenderer({renderAttestationPdf:async html=>{
    assert.ok(html.includes('Zoë López'));assert.ok(html.includes('not an acceptance or payment time'));assert.ok(!html.includes('SYNTHETIC HTML'));return receipt;}});
  const r=await render(input(original)),d=await PDFDocument.load(r.pdf_bytes,{updateMetadata:false});
  assert.equal(r.preview_pages,2);assert.equal(r.attestation_pages,1);assert.equal(d.getPageCount(),3);assert.equal(d.getCreationDate(),undefined);
  assert.equal(d.getModificationDate(),undefined);assert.equal(d.getPage(0).getWidth(),612);assert.equal(d.getPage(0).getHeight(),792);
});
test('hash/size mutation, unsupported name or too many source pages held',async()=>{
  const original=await pdf(),render=createRetailExecutionRenderer({renderAttestationPdf:async()=>pdf(1)});
  const wrong=input(original);wrong.document.preview_pdf_sha256=sha('wrong');await assert.rejects(()=>render(wrong),e=>e.code==='retail_execution_unverified');
  const unknown=input(original);unknown.name='署名';await assert.rejects(()=>render(unknown),e=>e.code==='retail_execution_unverified');
  await assert.rejects(async()=>render(input(await pdf(33))),e=>e.code==='retail_execution_unverified');
});
test('active actions, external URI, XFA and embedded files rejected before copy',async()=>{
  const mutations=[d=>d.catalog.set(PDFName.of('OpenAction'),d.context.obj({S:'JavaScript',JS:PDFString.of('unsafe')})),
    d=>d.getPage(0).node.set(PDFName.of('AA'),d.context.obj({})),d=>d.catalog.set(PDFName.of('XFA'),PDFString.of('unsafe')),
    d=>d.context.register(d.context.obj({Type:'Filespec',F:PDFString.of('remote')})),
    d=>d.context.register(d.context.obj({S:'URI',URI:PDFString.of('https://example.invalid')})),
    d=>d.catalog.set(PDFName.of('EmbeddedFiles'),d.context.obj({}))];
  const render=createRetailExecutionRenderer({renderAttestationPdf:async()=>pdf(1)});
  for(const mutate of mutations)await assert.rejects(async()=>render(input(await pdf(1,mutate))),e=>e.code==='retail_execution_unverified');
});
