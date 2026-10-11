import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyManualPost, applySavedPostMetrics, checkManualMetric } from './social-post-manual.mjs';
test('Manual post inputs validate counts, percentages, zero and clearing without coercing booleans', () => {
  for (const input of [-1,1.2,true,{},'abc',Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(checkManualMetric('views',input).ok,false);
  assert.deepEqual(checkManualMetric('views',0),{ok:true,value:0});
  assert.deepEqual(checkManualMetric('reach',''),{ok:true,value:null});
  assert.deepEqual(checkManualMetric('nonFollowersPct','62,5%'),{ok:true,value:62.5});
  assert.equal(checkManualMetric('nonFollowersPct',101).ok,false);
  assert.deepEqual(checkManualMetric('engagementRate',120),{ok:true,value:120});
  assert.equal(checkManualMetric('shop_id',1).ok,false);
});
test('Acknowledged edits survive stale refreshes, clear explicitly and yield to native metrics', () => {
  const post={views:100,reach:null,engagement:20,engagementRate:null,engagementBasis:'reach',follows:null,bands:{},manualMetrics:[]};
  const saved=[{metric:'reach',value:50},{metric:'follows',value:0}];
  const result=applySavedPostMetrics(post,saved);
  assert.equal(result.reach,50);assert.equal(result.follows,0);assert.equal(result.engagementRate,40);
  assert.equal(result.rateFromManual,true);assert.equal(post.reach,null);
  assert.equal(applySavedPostMetrics({...result,reach:30},saved).reach,50,'a stale manual value cannot replace the acknowledged edit');
  assert.equal(applySavedPostMetrics({...post,reach:60},saved).reach,60,'new provider data wins');
  const cleared=applySavedPostMetrics(result,[{metric:'reach',value:null}]);
  assert.equal(cleared.reach,null);assert.equal(cleared.engagementRate,null);assert.equal(cleared.manualMetrics.includes('reach'),false);
  const explicit={...post,manualMetrics:['engagementRate'],engagementRate:12};
  assert.equal(applySavedPostMetrics(explicit,[{metric:'engagementRate',value:15,basis:'reach'}]).engagementRate,15);
  assert.equal(applySavedPostMetrics(explicit,[{metric:'engagementRate',value:null,basis:'reach'}]).engagementRate,null);
  assert.equal(applySavedPostMetrics(explicit,[{metric:'engagementRate',value:15,basis:'views'}]).engagementRate,12);
  assert.equal(applySavedPostMetrics({...post,engagementBasis:'followers',engagementRate:4},[{metric:'engagement',value:30}]).engagementRate,4,'native engagement is never overridden');
});
test('Annotations fill gaps, preserve provider zeros and respect the rate denominator', () => {
  const entries=[{metric:'views',value:12},{metric:'reach',value:30},{metric:'engagementRate',value:15,basis:'reach'}];
  const post={views:0,reach:null,engagementRate:null,engagementBasis:'views'};
  const result=applyManualPost(post,entries);
  assert.equal(result.views,0);assert.equal(result.reach,30);assert.equal(result.engagementRate,null);
  assert.deepEqual(result.manualMetrics,['reach']);assert.equal(post.reach,null);
  assert.equal(applyManualPost({...post,engagementBasis:'reach'},entries).engagementRate,15);
  assert.equal(applyManualPost({...post,reach:40},entries).reach,40);
});
