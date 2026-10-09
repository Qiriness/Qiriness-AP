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
 assert.doesNotMatch(await audience.textContent(),/Paris|Cities/);
 assert.equal(await page.locator('.data-availability').count(),0);
 assert.doesNotMatch(await page.locator('#report').textContent(),/Historical follower totals cannot be reconstructed|No follower snapshot on or before/);
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
 const slots=[[2,9,59],[3,9,83],[4,9,47],[1,9,39],[10,11,57],[11,11,45],[9,10,59],[17,10,31]];
 const postingFixture={...fixture,posts:slots.map(([day,hour,engagement],i)=>({account_id:'a',external_id:'post-'+i,published_at:'2025-12-'+String(day).padStart(2,'0')+'T'+String(hour).padStart(2,'0')+':00:00Z',fetched_at:'2026-10-08T12:00:00Z',caption_excerpt:'A very long post caption '.repeat(30),engagement,views:100}))};
 await render(postingFixture);
 const activity=await page.locator('.posting-times').textContent();
 assert.match(activity,/10:00–11:0057 avg. engagement · 4 posts/);
 assert.match(activity,/12:00–13:0051 avg. engagement · 2 posts/);
 assert.match(activity,/11:00–12:0045 avg. engagement · 2 posts/);
 assert.match(activity,/Tuesday59 avg. engagement · 2 posts/);
 assert.match(activity,/Wednesday57 avg. engagement · 3 posts/);
 assert.match(activity,/Thursday46 avg. engagement · 2 posts/);
 assert.equal(await page.locator('.overfull').count(),0);
 const caption=await page.locator('.post-name').first().evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),overflow:getComputedStyle(el).textOverflow,whiteSpace:getComputedStyle(el).whiteSpace,title:el.title}));
 assert.ok(caption.width>0&&caption.scroll>caption.width);
 assert.ok(caption.height<=caption.lineHeight+1);
 assert.equal(caption.overflow,'ellipsis');assert.equal(caption.whiteSpace,'nowrap');assert.equal(caption.title,postingFixture.posts[0].caption_excerpt);
 await page.evaluate(async()=>{await SocialReport.setContext({endMonth:'2025-11'});});
 assert.doesNotMatch(await page.locator('.posting-times').textContent(),/57 avg/);
 assert.equal(await page.locator('.overfull').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: comparison totals, country-only audience, period-aware posting times, single-line ellipsis and removed availability text.');
}finally{await browser.close();}
