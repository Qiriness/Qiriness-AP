import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import ts from 'typescript';
import { adaptSocialReport } from '../../scripts/lib/social-report-data.mjs';
import { socialReportState } from '../../scripts/lib/social-report.mjs';

// Exercise the actual Next production renderer, including minified Function.toString().
// Expose its internal renderer only in this test process; never change built files.
const require=createRequire(import.meta.url);
require('../.next/server/app/api/insights/social/report/route.js');
const runtime=require('../.next/server/webpack-runtime.js');
let render;
for(const factory of Object.values(runtime.m)){
  const source=factory.toString();
  if(!source.includes('Report activity panel anchor missing.'))continue;
  const ast=ts.createSourceFile('factory.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let expression;
  const visit=node=>{
    if(ts.isFunctionExpression(node)&&node.getText(ast).includes('Report activity panel anchor missing.')&&node.getText(ast).includes('JSON.stringify'))expression=node.getText(ast);
    ts.forEachChild(node,visit);
  };
  visit(ast);
  assert.ok(expression,'Find production report renderer.');
  const exportsName=source.slice(source.indexOf('(')+1,source.indexOf(')')).split(',')[1];
  const expose=new Function('return ('+source.slice(0,-1)+';'+exportsName+'.testRender='+expression+';})')();
  const exports={};expose({exports},exports,runtime);render=exports.testRender;break;
}
assert.ok(render,'Production build required before this check.');
const data=adaptSocialReport({companyId:'dummy-production',timezone:'Europe/Paris',endMonth:'2025-12',asOf:'2026-10-09',accounts:[{id:'a',kind:'instagram',enabled:true}],days:[],audience:[],posts:[{account_id:'a',external_id:'post',published_at:'2025-12-02T09:00:00Z',fetched_at:'2026-10-08T12:00:00Z',caption_excerpt:'Dummy production post',engagement:57,views:100}]});
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:\/\//,r=>r.abort());
  await page.setContent(render(socialReportState(data,{name:'Dummy production',endMonth:'2025-12'})));
  await page.evaluate(async()=>{await window.SocialReport?.ready?.catch(()=>{});});
  assert.deepEqual(errors,[],'Production HTML must open without JavaScript errors.');
  assert.equal(await page.locator('.post-table tbody tr').count(),1);
  assert.match(await page.locator('.posting-times').textContent(),/10:00–11:0057 avg. engagement/);
  await page.evaluate(async()=>{await SocialReport.setContext({months:6});});
  assert.equal(await page.locator('.post-table tbody tr').count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: production-minified report renders posts/activity and period controls.');
}finally{await browser.close();}
