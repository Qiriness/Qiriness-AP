import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
import { adaptSocialReport } from '../../scripts/lib/social-report-data.mjs';
import { renderSocialReport, socialReportState } from '../../scripts/lib/social-report.mjs';
let executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if(!executablePath&&process.platform==='win32')for(const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'])if(await access(path).then(()=>true,()=>false)){executablePath=path;break;}
const days=[];
for(let date=new Date('2023-12-31T00:00:00Z');date<=new Date('2025-12-31T00:00:00Z');date.setUTCDate(date.getUTCDate()+1))days.push({account_id:'a',day:date.toISOString().slice(0,10),views:10,engagement:2,posts:1,follows:2,unfollows:3,followers:1000-days.length});
const fixture={companyId:'dummy-wiring',timezone:'Europe/Paris',asOf:'2026-10-09',endMonth:'2025-12',accounts:[{id:'a',kind:'instagram',enabled:true}],days,posts:[{account_id:'a',external_id:'dummy-post',published_at:'2025-12-15T12:00:00Z',fetched_at:'2026-10-08T12:00:00Z',caption_excerpt:'Dummy manual percentage',non_followers_pct:75}],audience:[
 {account_id:'a',captured_on:'2026-10-07',dimension:'gender',key:'female',value:90},
 {account_id:'a',captured_on:'2026-10-07',dimension:'gender',key:'male',value:10},
 {account_id:'a',captured_on:'2026-10-07',dimension:'age',key:'25-34',value:100},
 {account_id:'a',captured_on:'2026-10-07',dimension:'country',key:'FR',value:100},
 {account_id:'a',captured_on:'2026-10-07',dimension:'city',key:'Paris',value:100}]};
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:\/\//,r=>r.abort());
 const render=async input=>{await page.goto('about:blank');await page.setContent(renderSocialReport(socialReportState(adaptSocialReport(input),{name:'Dummy report',endMonth:input.endMonth,months:1})));await page.evaluate(async()=>{await SocialReport.ready;});};
 await render(fixture);
 const audience=page.locator('.audience-grid').first();
 assert.match(await audience.textContent(),/Female/);assert.match(await audience.textContent(),/25-34/);assert.match(await audience.textContent(),/FR/);
 assert.match(await audience.textContent(),/Paris/);
 assert.match(await page.locator('.post-table').textContent(),/75/);
 assert.match(await page.locator('#report').textContent(),/latest available; after the reporting period/);
 for(const [months,start,previousStart,previousEnd] of [[1,'2025-12-01','2025-11-01','2025-11-30'],[6,'2025-07-01','2025-01-01','2025-06-30'],[12,'2025-01-01','2024-01-01','2024-12-31']]){
  await page.evaluate(async months=>{await SocialReport.setContext({months});},months);
  const computed=await page.evaluate(()=>SocialReport.getComputed());
  assert.equal(computed.range.current.start,start);assert.equal(computed.range.previous.start,previousStart);assert.equal(computed.range.previous.end,previousEnd);
  const n=days.filter(d=>d.day>=start&&d.day<='2025-12-31').length,prior=days.filter(d=>d.day>=previousStart&&d.day<=previousEnd).length;
  assert.equal(computed.platforms[0].current.views,n*10);assert.equal(computed.platforms[0].previous.views,prior*10);
  assert.equal(computed.platforms[0].current.netFollows,-n);assert.equal(computed.platforms[0].previous.netFollows,-prior);
  assert.equal(computed.platforms[0].current.followers,days.at(-1).followers);
  assert.equal(await page.locator('.month-tick').count(),months===12?12:6);
  assert.equal(await page.locator('.overfull').count(),0);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: dated audience, followers, signed net changes, actual 1/6/12-month totals, period boundaries, trend length and blank explanations.');
}finally{await browser.close();}
