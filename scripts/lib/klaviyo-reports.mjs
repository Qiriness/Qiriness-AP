/**
 * Pure: what the Klaviyo sync asks for, how the answers become rows, and how
 * the Marketing card reads them back.
 *
 * COUNTS ARE STORED, RATES ARE COMPUTED. Recipients, delivered, unique opens,
 * unique clicks, unique conversions and conversion value add up across days
 * and messages; a click rate does not. So only counts reach the table, and
 * every rate on the card is rebuilt here from the summed counts — click rate
 * over delivered, conversion rate and revenue per recipient over recipients,
 * which are Klaviyo's own denominators.
 *
 * FLOWS BY DAY, CAMPAIGNS WHOLE. A flow sends every day and the Insights range
 * is any window, so a flow is stored per day (the flow series report, daily
 * interval — at most 60 days a request). A campaign is sent once, so it is
 * stored whole and placed in a range by its send time.
 */

/** The counts asked of both reports. Rates are deliberately absent. */
export const KLAVIYO_STATISTICS = Object.freeze([
  'recipients',
  'delivered',
  'opens_unique',
  'clicks_unique',
  'conversion_uniques',
  'conversion_value'
]);

/** Klaviyo caps a daily series at 60 days; one day short, so a boundary never trips it. */
export const FLOW_WINDOW_DAYS = 59;
/** First sync: a year of flow days. Afterwards the nightly rewrites one window. */
export const FLOW_BACKFILL_DAYS = 365;
/** Campaigns sent in the last year are re-read nightly: late conversions still land on them. */
export const CAMPAIGN_LOOKBACK_DAYS = 365;

const DAY_MS = 86_400_000;

// --- the key ---------------------------------------------------------------------

/**
 * A Klaviyo private key is `pk_` and a long token. Checked here only for shape —
 * whether Klaviyo accepts it is checked by calling Klaviyo before it is saved.
 */
export function validateKlaviyoKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) return { ok: false, error: 'Paste the private API key.' };
  if (/\s/.test(key)) return { ok: false, error: 'The key contains spaces — paste it again.' };
  if (!key.startsWith('pk_')) {
    return { ok: false, error: 'That is not a private key: Klaviyo private keys start with "pk_". The six-character public key cannot read reports.' };
  }
  if (key.length < 20 || key.length > 200) return { ok: false, error: 'That key is not the length of a Klaviyo private key.' };
  return { ok: true, key };
}

/** The last four characters: the only part of the key ever shown again. */
export function keyHint(key) {
  return String(key).trim().slice(-4);
}

/**
 * The metric revenue is counted on: Shopify's "Placed Order". Klaviyo has one
 * per integration, so a Shopify one is preferred over a same-named custom one.
 */
export function pickConversionMetric(metrics) {
  const placed = (metrics ?? []).filter((m) => m?.attributes?.name === 'Placed Order');
  const shopify = placed.find((m) => /shopify/i.test(m?.attributes?.integration?.name ?? ''));
  return (shopify ?? placed[0])?.id ?? null;
}

// --- what is asked ---------------------------------------------------------------

/** YYYY-MM-DD of a Date, in UTC. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Consecutive windows of at most FLOW_WINDOW_DAYS covering the last `days`
 * days up to and including today, oldest first. `end` is exclusive (the next
 * midnight). Klaviyo reads both on the account's own clock.
 */
export function flowWindows(now, days) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  const start = end - days * DAY_MS;
  const windows = [];
  for (let from = start; from < end; from += FLOW_WINDOW_DAYS * DAY_MS) {
    const to = Math.min(from + FLOW_WINDOW_DAYS * DAY_MS, end);
    windows.push({ start: `${isoDay(new Date(from))}T00:00:00`, end: `${isoDay(new Date(to))}T00:00:00` });
  }
  return windows;
}

export function flowSeriesBody(window, conversionMetricId) {
  return {
    data: {
      type: 'flow-series-report',
      attributes: {
        statistics: [...KLAVIYO_STATISTICS],
        timeframe: { start: window.start, end: window.end },
        interval: 'daily',
        conversion_metric_id: conversionMetricId,
        group_by: ['flow_id', 'flow_message_id', 'flow_name']
      }
    }
  };
}

export function campaignValuesBody(now, conversionMetricId) {
  // A values report has no 60-day cap: one request covers the whole year.
  const start = flowWindows(now, CAMPAIGN_LOOKBACK_DAYS)[0].start;
  const end = flowWindows(now, 1)[0].end;
  return {
    data: {
      type: 'campaign-values-report',
      attributes: {
        statistics: [...KLAVIYO_STATISTICS],
        timeframe: { start, end },
        conversion_metric_id: conversionMetricId,
        group_by: ['campaign_id', 'campaign_message_id', 'send_channel']
      }
    }
  };
}

// --- how the answers become rows -----------------------------------------------

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyCounts() {
  return { recipients: 0, delivered: 0, opens_unique: 0, clicks_unique: 0, conversions: 0, conversion_value: 0 };
}

function addCounts(target, stats, at) {
  const pick = (name) => num(at === undefined ? stats?.[name] : stats?.[name]?.[at]);
  target.recipients += pick('recipients');
  target.delivered += pick('delivered');
  target.opens_unique += pick('opens_unique');
  target.clicks_unique += pick('clicks_unique');
  target.conversions += pick('conversion_uniques');
  target.conversion_value += pick('conversion_value');
}

function rounded(counts) {
  return {
    recipients: Math.round(counts.recipients),
    delivered: Math.round(counts.delivered),
    opens_unique: Math.round(counts.opens_unique),
    clicks_unique: Math.round(counts.clicks_unique),
    conversions: Math.round(counts.conversions),
    conversion_value: Math.round(counts.conversion_value * 100) / 100
  };
}

/**
 * A flow series report -> one row per flow and day, its messages summed.
 * Days on which the flow did nothing at all are dropped: an all-zero row says
 * nothing a missing row does not.
 */
export function foldFlowSeries(payload, shopId) {
  const attributes = payload?.data?.attributes ?? {};
  const days = (attributes.date_times ?? []).map((d) => String(d).slice(0, 10));
  const byKey = new Map();
  for (const result of attributes.results ?? []) {
    const flowId = result?.groupings?.flow_id;
    if (!flowId) continue;
    days.forEach((day, i) => {
      const key = `${flowId}|${day}`;
      let row = byKey.get(key);
      if (!row) {
        row = { flowId, day, name: null, counts: emptyCounts() };
        byKey.set(key, row);
      }
      row.name = row.name ?? result.groupings.flow_name ?? null;
      addCounts(row.counts, result.statistics, i);
    });
  }
  return [...byKey.values()]
    .filter((row) => Object.values(row.counts).some((v) => v !== 0))
    .map((row) => ({ shop_id: shopId, flow_id: row.flowId, day: row.day, flow_name: row.name, ...rounded(row.counts) }));
}

/**
 * A campaign values report + the campaign list -> one row per campaign, its
 * messages and channels summed, named and dated from the list.
 */
export function foldCampaigns(payload, campaigns, shopId) {
  const meta = new Map();
  for (const campaign of campaigns ?? []) {
    if (!campaign?.id) continue;
    const a = campaign.attributes ?? {};
    meta.set(campaign.id, { name: a.name ?? null, sendTime: a.send_time ?? a.scheduled_at ?? null, channel: campaign.channel ?? null });
  }
  const byId = new Map();
  for (const result of payload?.data?.attributes?.results ?? []) {
    const id = result?.groupings?.campaign_id;
    if (!id) continue;
    let row = byId.get(id);
    if (!row) {
      row = { id, channels: new Set(), counts: emptyCounts() };
      byId.set(id, row);
    }
    if (result.groupings.send_channel) row.channels.add(result.groupings.send_channel);
    addCounts(row.counts, result.statistics);
  }
  return [...byId.values()].map((row) => {
    const m = meta.get(row.id);
    return {
      shop_id: shopId,
      campaign_id: row.id,
      name: m?.name ?? null,
      channel: [...row.channels].sort().join(',') || m?.channel || null,
      send_time: m?.sendTime ?? null,
      ...rounded(row.counts)
    };
  });
}

// --- how the card reads them ---------------------------------------------------

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * The card's summary and table from `insights_klaviyo_messages` rows. The
 * summary is every flow and campaign in the range; the table lists only those
 * with at least one click (the owner's rule, 2026-09-25), by open rate —
 * what the owner reads first (2026-09-25); revenue stays as a column.
 */
export function summariseKlaviyoMessages(rows) {
  const all = (rows ?? []).map((row) => {
    const recipients = num(row.recipients);
    const delivered = num(row.delivered);
    const opens = num(row.opens_unique);
    const clicks = num(row.clicks_unique);
    const conversions = num(row.conversions);
    const revenue = num(row.conversion_value);
    return {
      kind: row.kind === 'campaign' ? 'campaign' : 'flow',
      id: String(row.id),
      name: row.name ?? null,
      sentAt: row.sent_at ?? null,
      recipients,
      opens,
      clicks,
      conversions,
      revenue,
      openRate: ratio(opens, delivered),
      clickRate: ratio(clicks, delivered),
      conversionRate: ratio(conversions, recipients),
      revenuePerRecipient: ratio(revenue, recipients),
      delivered
    };
  });

  const total = all.reduce(
    (sum, row) => ({
      recipients: sum.recipients + row.recipients,
      delivered: sum.delivered + row.delivered,
      opens: sum.opens + row.opens,
      clicks: sum.clicks + row.clicks,
      revenue: sum.revenue + row.revenue
    }),
    { recipients: 0, delivered: 0, opens: 0, clicks: 0, revenue: 0 }
  );

  const clicked = all
    .filter((row) => row.clicks > 0)
    .sort((a, b) => (b.openRate ?? -1) - (a.openRate ?? -1) || b.recipients - a.recipients)
    .map(({ delivered, ...row }) => row);

  return {
    summary: {
      revenue: total.revenue,
      recipients: total.recipients,
      openRate: ratio(total.opens, total.delivered),
      clickRate: ratio(total.clicks, total.delivered),
      revenuePerRecipient: ratio(total.revenue, total.recipients)
    },
    rows: clicked,
    hiddenWithoutClicks: all.length - clicked.length
  };
}
