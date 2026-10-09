import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptSocialReport } from './social-report-data.mjs';
import { reportPeriodTotals, reportMissingReasons } from './social-report-availability.mjs';
const base={companyId:'dummy',timezone:'Europe/Paris',endMonth:'2025-12',asOf:'2026-10-09',accounts:[{id:'a',kind:'instagram',enabled:true}],days:[],posts:[],audience:[]};
test('report retains the available latest audience snapshot and clearly dates it independently of report end',()=>{
 const data=adaptSocialReport({...base,audience:[{account_id:'a',captured_on:'2026-10-08',dimension:'gender',key:'F',value:90},{account_id:'a',captured_on:'2026-10-08',dimension:'gender',key:'M',value:10}]});
 assert.equal(data.platforms[0].audienceSnapshots.length,1);
 assert.equal(data.platforms[0].audienceSnapshots[0].asOf,'2026-10-08');
 assert.deepEqual(data.platforms[0].audienceSnapshots[0].gender,[{label:'Female',value:90},{label:'Male',value:10}]);
});
test('dated follower snapshots and measured daily net follows are independent of other metric coverage',()=>{
 const days=Array.from({length:31},(_,i)=>({account_id:'a',day:'2025-12-'+String(i+1).padStart(2,'0'),follows:3,unfollows:1}));
 days[29].followers=160;
 days.push({account_id:'a',day:'2025-11-29',followers:100});
 const month=adaptSocialReport({...base,days}).platforms[0].monthly.at(-1);
 assert.equal(month.followersStart,100);
 assert.equal(month.followersEnd,160);
 assert.equal(month.netFollows,62);
 assert.equal(month.followersEndDay,'2025-12-30');
});

test('6m and 12m compare adjacent complete calendar periods with exact measured totals and net changes',()=>{
 const days=[];
 for(let date=new Date('2023-12-31T00:00:00Z');date<=new Date('2025-12-31T00:00:00Z');date.setUTCDate(date.getUTCDate()+1))days.push({account_id:'a',day:date.toISOString().slice(0,10),views:10,engagement:2,posts:1,follows:2,unfollows:3,followers:1000});
 const p=adaptSocialReport({...base,days}).platforms[0];
 for(const [months,start,previousStart,previousEnd] of [[6,'2025-07-01','2025-01-01','2025-06-30'],[12,'2025-01-01','2024-01-01','2024-12-31']]){
  const range=(from,to)=>({start:from,end:to,months:[...new Set(days.filter(d=>d.day>=from&&d.day<=to).map(d=>d.day.slice(0,7)))]});
  const current=reportPeriodTotals(p,range(start,'2025-12-31'),'views');
  const previous=reportPeriodTotals(p,range(previousStart,previousEnd),'views');
  const expected=days.filter(d=>d.day>=start&&d.day<='2025-12-31').length;
  const expectedPrevious=days.filter(d=>d.day>=previousStart&&d.day<=previousEnd).length;
  assert.equal(current.totalMonths,months);assert.equal(previous.totalMonths,months);
  assert.equal(current.views,expected*10);assert.equal(previous.views,expectedPrevious*10);
  assert.equal(current.netFollows,-expected);assert.equal(previous.netFollows,-expectedPrevious);
  assert.equal(current.followers,1000);assert.equal(current.engagementRate,0.2);
 }
});
test('incomplete comparison history stays null with precise coverage; snapshots still show independently',()=>{
 const p={id:'instagram',nativePeriodMetrics:[],monthly:[{month:'2025-12',status:'partial',views:null,followersEnd:140,followersEndDay:'2025-12-30',coverage:{views:{expected:31,measured:20}}}]};
 const range={months:['2025-12'],start:'2025-12-01',end:'2025-12-31'};
 const totals=reportPeriodTotals(p,range,'views');
 assert.equal(totals.views,null);assert.equal(totals.followers,140);assert.equal(totals.netFollows,null);
 const reasons=reportMissingReasons(p,totals,range);
 assert.match(reasons.find(([name])=>name==='Views')[1],/20 of 31/);
 assert.match(reasons.find(([name])=>name==='Follower observation')[1],/2025-12-30/);
});

test('manual post non-follower percentages retain their value and unrecorded denominator',()=>{
 const p=adaptSocialReport({...base,posts:[{account_id:'a',external_id:'p',published_at:'2025-12-15T12:00:00Z',fetched_at:'2026-10-08T12:00:00Z',non_followers_pct:75}]}).platforms[0].posts[0];
 assert.equal(p.nonFollowerShare,0.75);assert.equal(p.nonFollowerBasis,'manual');
});
