import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOW_WINDOW_DAYS,
  campaignValuesBody,
  flowSeriesBody,
  flowWindows,
  foldCampaigns,
  foldFlowSeries,
  keyHint,
  pickConversionMetric,
  summariseKlaviyoMessages,
  validateKlaviyoKey
} from './klaviyo-reports.mjs';

const SHOP = 'shop-1';
const NOW = new Date('2026-09-25T10:00:00Z');

test('a private key must look like one; the public key is refused by name', () => {
  assert.equal(validateKlaviyoKey('  pk_0123456789abcdef0123456789  ').ok, true);
  assert.equal(validateKlaviyoKey('  pk_0123456789abcdef0123456789  ').key, 'pk_0123456789abcdef0123456789');
  assert.match(validateKlaviyoKey('AbC123').error, /start with "pk_"/);
  assert.match(validateKlaviyoKey('').error, /Paste/);
  assert.match(validateKlaviyoKey('pk_abc def0123456789012345').error, /spaces/);
  assert.equal(validateKlaviyoKey('pk_short').ok, false);
});

test('only the last four characters are kept as a hint', () => {
  assert.equal(keyHint('pk_0123456789abcdef0123456789'), '6789');
});

test('revenue is counted on Shopify\'s Placed Order when there is more than one', () => {
  const metrics = [
    { id: 'm1', attributes: { name: 'Opened Email', integration: { name: 'Klaviyo' } } },
    { id: 'm2', attributes: { name: 'Placed Order', integration: { name: 'API' } } },
    { id: 'm3', attributes: { name: 'Placed Order', integration: { name: 'Shopify' } } }
  ];
  assert.equal(pickConversionMetric(metrics), 'm3');
  assert.equal(pickConversionMetric(metrics.slice(0, 2)), 'm2');
  assert.equal(pickConversionMetric(metrics.slice(0, 1)), null);
});

test('flow windows cover the days asked, end tomorrow at midnight, and never exceed the cap', () => {
  const windows = flowWindows(NOW, 365);
  assert.equal(windows.at(-1).end, '2026-09-26T00:00:00');
  assert.equal(windows[0].start, '2025-09-26T00:00:00');
  for (const w of windows) {
    const span = (Date.parse(`${w.end}Z`) - Date.parse(`${w.start}Z`)) / 86_400_000;
    assert.ok(span > 0 && span <= FLOW_WINDOW_DAYS, `${w.start} -> ${w.end}`);
  }
  for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i].start, windows[i - 1].end);
  assert.equal(flowWindows(NOW, FLOW_WINDOW_DAYS).length, 1);
});

test('the report bodies ask for counts only', () => {
  const flow = flowSeriesBody({ start: 'a', end: 'b' }, 'm3').data.attributes;
  assert.equal(flow.interval, 'daily');
  assert.equal(flow.conversion_metric_id, 'm3');
  assert.ok(flow.group_by.includes('flow_id') && flow.group_by.includes('flow_message_id'));
  assert.ok(!flow.statistics.some((s) => /rate|per_recipient/.test(s)));
  const campaign = campaignValuesBody(NOW, 'm3').data.attributes;
  assert.equal(campaign.timeframe.end, '2026-09-26T00:00:00');
  assert.equal(campaign.timeframe.start, '2025-09-26T00:00:00');
});

test('a flow series folds to one row per flow and day, messages summed, empty days dropped', () => {
  const payload = {
    data: {
      attributes: {
        date_times: ['2026-09-01T00:00:00+02:00', '2026-09-02T00:00:00+02:00'],
        results: [
          {
            groupings: { flow_id: 'F1', flow_message_id: 'a', flow_name: 'Welcome' },
            statistics: { recipients: [10, 0], delivered: [9, 0], opens_unique: [5, 0], clicks_unique: [2, 0], conversion_uniques: [1, 0], conversion_value: [40.125, 0] }
          },
          {
            groupings: { flow_id: 'F1', flow_message_id: 'b', flow_name: 'Welcome' },
            statistics: { recipients: [4, 0], delivered: [4, 0], opens_unique: [1, 0], clicks_unique: [1, 0], conversion_uniques: [0, 0], conversion_value: [0, 0] }
          }
        ]
      }
    }
  };
  assert.deepEqual(foldFlowSeries(payload, SHOP), [
    { shop_id: SHOP, flow_id: 'F1', day: '2026-09-01', flow_name: 'Welcome', recipients: 14, delivered: 13, opens_unique: 6, clicks_unique: 3, conversions: 1, conversion_value: 40.13 }
  ]);
});

test('campaigns fold per campaign, named and dated from the list', () => {
  const payload = {
    data: {
      attributes: {
        results: [
          { groupings: { campaign_id: 'C1', campaign_message_id: 'x', send_channel: 'email' }, statistics: { recipients: 100, delivered: 98, opens_unique: 40, clicks_unique: 7, conversion_uniques: 2, conversion_value: 90 } },
          { groupings: { campaign_id: 'C2', campaign_message_id: 'y', send_channel: 'email' }, statistics: { recipients: 5, delivered: 5, clicks_unique: null } }
        ]
      }
    }
  };
  const list = [{ id: 'C1', channel: 'email', attributes: { name: 'Rentrée', send_time: '2026-09-03T08:00:00+00:00' } }];
  const [c1, c2] = foldCampaigns(payload, list, SHOP);
  assert.deepEqual(c1, {
    shop_id: SHOP, campaign_id: 'C1', name: 'Rentrée', channel: 'email', send_time: '2026-09-03T08:00:00+00:00',
    recipients: 100, delivered: 98, opens_unique: 40, clicks_unique: 7, conversions: 2, conversion_value: 90
  });
  assert.equal(c2.name, null);
  assert.equal(c2.clicks_unique, 0);
});

test('the card: summary over everything, table only what was clicked, by open rate', () => {
  const out = summariseKlaviyoMessages([
    { kind: 'flow', id: 'F1', name: 'Welcome', recipients: 200, delivered: 190, opens_unique: 95, clicks_unique: 19, conversions: 4, conversion_value: '120.50' },
    { kind: 'campaign', id: 'C1', name: 'Rentrée', sent_at: '2026-09-03T08:00:00Z', recipients: 1000, delivered: 980, opens_unique: 196, clicks_unique: 30, conversions: 5, conversion_value: 300 },
    { kind: 'flow', id: 'F2', name: 'Browse abandon', recipients: 50, delivered: 30, clicks_unique: 0, conversions: 0, conversion_value: 0 }
  ]);
  // F1 opened at 50%, C1 at 20%: open rate leads, whatever the revenue.
  assert.deepEqual(out.rows.map((r) => r.id), ['F1', 'C1']);
  assert.equal(out.rows[0].openRate, 95 / 190);
  assert.equal(out.summary.openRate, 291 / 1200);
  assert.equal(out.hiddenWithoutClicks, 1);
  assert.equal(out.summary.revenue, 420.5);
  assert.equal(out.summary.recipients, 1250);
  assert.equal(out.summary.clickRate, 49 / 1200);
  assert.equal(out.rows[0].clickRate, 19 / 190);
  assert.equal(out.rows[0].conversionRate, 4 / 200);
  assert.equal(out.rows[1].revenuePerRecipient, 0.3);
  assert.equal('delivered' in out.rows[0], false);
});

test('an empty range has no rates rather than zero ones', () => {
  const out = summariseKlaviyoMessages([]);
  assert.equal(out.summary.clickRate, null);
  assert.equal(out.summary.openRate, null);
  assert.equal(out.summary.revenuePerRecipient, null);
  assert.deepEqual(out.rows, []);
});
