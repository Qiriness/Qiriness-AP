import assert from 'node:assert/strict';
import test from 'node:test';

import { campaignUrl, captionExcerpt, normalisePublisher } from './social-model.mjs';

test('a campaign opens in its own ads interface; without its ids there is no link', () => {
  assert.equal(
    campaignUrl({ kind: 'meta_ads', accountExternalId: 'act_123', campaignId: '120' }),
    'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=120'
  );
  assert.equal(campaignUrl({ kind: 'google_ads', accountExternalId: '123-456-7890', campaignId: '77' }), 'https://ads.google.com/aw/overview?__e=1234567890&campaignId=77');
  assert.equal(campaignUrl({ kind: 'google_ads', accountExternalId: null, campaignId: '77' }), null);
  assert.equal(campaignUrl({ kind: 'instagram', accountExternalId: '1', campaignId: '2' }), null);
});

test('captions are one line, at most 140 characters; unknown publishers read as other', () => {
  assert.equal(captionExcerpt('  a\n\nb  '), 'a b');
  assert.equal(captionExcerpt('x'.repeat(200)).length, 140);
  assert.equal(captionExcerpt(''), null);
  assert.equal(normalisePublisher('Instagram'), 'instagram');
  assert.equal(normalisePublisher('threads_new'), 'other');
});
