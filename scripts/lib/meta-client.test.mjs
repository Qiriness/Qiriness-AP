import assert from 'node:assert/strict';
import test from 'node:test';

import { appSecretProof, createMetaClient, MetaError } from './meta-client.mjs';

const TOKEN = 'EAAdummyTokenValue0123456789';
const SECRET = 'dummy-app-secret';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses, seen = []) {
  return createMetaClient({
    token: TOKEN,
    appSecret: SECRET,
    graphVersion: 'v23.0',
    sleep: async () => {},
    fetchImpl: async (url) => {
      seen.push(new URL(url));
      return responses.shift();
    }
  });
}

test('every call carries the token and its appsecret_proof, and pages are followed', async () => {
  const seen = [];
  const meta = client(
    [
      reply(200, { data: [{ account_id: '1' }], paging: { next: `https://graph.facebook.com/v23.0/me/adaccounts?after=X&access_token=${TOKEN}` } }),
      reply(200, { data: [{ account_id: '2' }] })
    ],
    seen
  );
  const accounts = await meta.listAdAccounts();
  assert.deepEqual(accounts.map((a) => a.account_id), ['1', '2']);
  assert.equal(seen[0].pathname, '/v23.0/me/adaccounts');
  assert.equal(seen[0].searchParams.get('appsecret_proof'), appSecretProof(TOKEN, SECRET));
  assert.equal(seen[1].searchParams.get('after'), 'X');
});

test('a rate limit is waited out, then the call succeeds', async () => {
  const meta = client([reply(400, { error: { code: 17, message: 'User request limit reached' } }), reply(200, { id: '1', name: 'x' })]);
  assert.deepEqual(await meta.me(), { id: '1', name: 'x' });
});

test('an expired token asks for a reconnect, and the error never names the token', async () => {
  const meta = client([reply(400, { error: { code: 190, message: 'Error validating access token' } })]);
  await assert.rejects(meta.me(), (error) => {
    assert.ok(error instanceof MetaError);
    assert.equal(error.needsReconnect, true);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
});

test('a retired metric is dropped, not fatal: the rest are asked one by one', async () => {
  const seen = [];
  const meta = client(
    [
      reply(400, { error: { code: 100, message: '(#100) metric[1] must be one of the following values' } }),
      reply(200, { data: [{ name: 'views', total_value: { value: 5 } }] }),
      reply(400, { error: { code: 100, message: 'invalid metric' } })
    ],
    seen
  );
  const result = await meta.insights('17841', ['views', 'impressions'], { period: 'day' });
  assert.deepEqual(result.data, [{ name: 'views', total_value: { value: 5 } }]);
  assert.deepEqual(result.failed, ['impressions']);
  assert.equal(seen[1].searchParams.get('metric'), 'views');
});

test('a refused permission on insights is not measured, and says so; other errors are thrown', async () => {
  const denied = client([reply(403, { error: { code: 10, message: '(#10) Application does not have permission for this action' } })]);
  assert.deepEqual(await denied.insights('1', ['page_post_engagements', 'page_follows']), {
    data: [],
    failed: ['page_post_engagements', 'page_follows'],
    denied: true
  });
  const broken = client([reply(400, { error: { code: 1, message: 'An unknown error occurred' } })]);
  await assert.rejects(broken.insights('1', ['views']), (error) => error.code === 1 && !error.needsReconnect);
});

test('outside insights, a refused permission still fails the call', async () => {
  const meta = client([reply(400, { error: { code: 10, message: "(#10) This endpoint requires the 'pages_read_user_content' permission" } })]);
  await assert.rejects(meta.pagePosts('1', 'page-token', null), (error) => error.code === 10);
});
