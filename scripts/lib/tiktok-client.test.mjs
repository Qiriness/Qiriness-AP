import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exchangeTikTokCode,createTikTokClient,foldTikTokVideo,tiktokAuthorizeUrl,TIKTOK_SCOPES} from './tiktok-client.mjs';
const env={TIKTOK_CLIENT_KEY:'dummy-key',TIKTOK_CLIENT_SECRET:'dummy-secret',SOCIAL_OAUTH_STATE_SECRET:'x'.repeat(32)};
test('network failures never leak request or token material', async () => {
  await assert.rejects(exchangeTikTokCode({ env, code: 'dummy', redirect: 'https://example.invalid', fetchImpl: async () => { throw new Error('secret-upstream-data'); } }), error => !error.message.includes('secret-upstream-data'));
});
test('failed rotation persistence stops API calls before the renewed token is used', async () => {
  let calls = 0;
  const client = createTikTokClient({ env, bundle: { accessToken: 'old', refreshToken: 'dummy', expiresAt: 0 },
    persist: async () => { throw new Error('Persistence unavailable'); },
    fetchImpl: async () => { calls++; return Response.json({ access_token: 'new', refresh_token: 'rotated', open_id: 'dummy', expires_in: 86400, refresh_expires_in: 31536000 }); }
  });
  await assert.rejects(client.profile(), /Persistence unavailable/);
  assert.equal(calls, 1);
});
test('TikTok consent and code exchange use exact redirect and required read scopes',async()=>{
 const url=new URL(tiktokAuthorizeUrl({clientKey:env.TIKTOK_CLIENT_KEY,redirect:'https://example.invalid/callback',state:'signed-state'}));assert.equal(url.searchParams.get('scope'),TIKTOK_SCOPES.join(','));assert.equal(url.searchParams.get('state'),'signed-state');
 const result=await exchangeTikTokCode({code:'dummy-code',redirect:'https://example.invalid/callback',env,fetchImpl:async(url,options)=>{assert.equal(options.body.get('grant_type'),'authorization_code');assert.equal(options.body.get('redirect_uri'),'https://example.invalid/callback');return Response.json({access_token:'dummy-access',refresh_token:'dummy-refresh',expires_in:86400,refresh_expires_in:31536000,open_id:'dummy-id',scope:TIKTOK_SCOPES.join(',')});}});assert.equal(result.bundle.openId,'dummy-id');assert.deepEqual(result.scopes,TIKTOK_SCOPES);
});
test('Expired TikTok access token is refreshed, persisted and used for resumable video pages',async()=>{
 let persisted,calls=0;const client=createTikTokClient({env,bundle:{accessToken:'old',refreshToken:'refresh',expiresAt:0},persist:async value=>{persisted=value;},fetchImpl:async(url,options)=>{calls++;if(String(url).includes('/oauth/token/')){assert.equal(options.body.get('grant_type'),'refresh_token');return Response.json({access_token:'new',refresh_token:'new-refresh',expires_in:86400,refresh_expires_in:31536000,open_id:'dummy-id',scope:TIKTOK_SCOPES.join(',')});}assert.equal(options.headers.Authorization,'Bearer new');assert.equal(JSON.parse(options.body).cursor,12345);return Response.json({error:{code:'ok'},data:{videos:[],has_more:false,cursor:12345}});}});await client.videos('12345');assert.equal(calls,2);assert.equal(persisted.refreshToken,'new-refresh');
});
test('TikTok video counts remain lifetime values and unsupported metrics stay null',()=>{const row=foldTikTokVideo({id:'1',create_time:1750000000,view_count:100,like_count:8,comment_count:2,share_count:3});assert.equal(row.engagement,13);assert.equal(row.views,100);assert.equal(row.reach,null);assert.equal(row.saves,null);assert.equal(foldTikTokVideo({id:'1',create_time:1750000000,like_count:8}).engagement,null);});
test('TikTok errors never include upstream token material',async()=>{await assert.rejects(exchangeTikTokCode({env,code:'dummy',redirect:'https://example.invalid',fetchImpl:async()=>Response.json({error:'invalid_grant',error_description:'secret-upstream-data'},{status:400})}),error=>error.needsReconnect&&!error.message.includes('secret-upstream-data'));});
