import { createKlaviyoClient } from './klaviyo-client.mjs';
import {
  FLOW_BACKFILL_DAYS,
  FLOW_WINDOW_DAYS,
  campaignValuesBody,
  flowSeriesBody,
  flowWindows,
  foldCampaigns,
  foldFlowSeries,
  keyHint,
  pickConversionMetric,
  validateKlaviyoKey
} from './klaviyo-reports.mjs';
import { supabaseRpc, supabaseSelect, supabaseUpdate, supabaseUpsert } from './supabase-rest-client.mjs';
import { KLAVIYO_RPC, KLAVIYO_T } from './tables.mjs';

const UPSERT_CHUNK = 500;

/**
 * Check a key against Klaviyo, then store it. Nothing is saved unless Klaviyo
 * answered with the account's metrics AND one of them is "Placed Order" —
 * without it there is no revenue to report, so a key that cannot see it is
 * refused rather than saved and left to fail every night.
 *
 * @param {{ supabase: object, shopId: string, key: unknown, savedBy?: string | null, createClient?: Function }} input
 * @returns {Promise<{ ok: true, hint: string } | { ok: false, error: string }>}
 */
export async function connectKlaviyo({ supabase, shopId, key, savedBy = null, createClient = createKlaviyoClient }) {
  const checked = validateKlaviyoKey(key);
  if (!checked.ok) return { ok: false, error: checked.error };

  let metrics;
  try {
    metrics = await createClient(checked.key).listMetrics();
  } catch (error) {
    const status = error?.status;
    if (status === 401) return { ok: false, error: 'Klaviyo rejected this key. Check it was copied whole and has not been revoked.' };
    if (status === 403) return { ok: false, error: 'This key cannot read metrics. Give it read access to Metrics, Flows and Campaigns.' };
    return { ok: false, error: error instanceof Error ? error.message : 'Klaviyo could not be reached.' };
  }

  const metricId = pickConversionMetric(metrics);
  if (!metricId) {
    return { ok: false, error: 'Klaviyo has no "Placed Order" metric on this account, so revenue cannot be attributed. Is the Shopify integration connected in Klaviyo?' };
  }

  await supabaseRpc(supabase, KLAVIYO_RPC.SAVE_KEY, {
    p_shop: shopId,
    p_key: checked.key,
    p_hint: keyHint(checked.key),
    p_metric_id: metricId,
    p_saved_by: savedBy
  });
  return { ok: true, hint: keyHint(checked.key) };
}

export async function disconnectKlaviyo({ supabase, shopId }) {
  await supabaseRpc(supabase, KLAVIYO_RPC.CLEAR_KEY, { p_shop: shopId });
}

/** The connection row, without the key. Null when Klaviyo is not connected. */
export async function readKlaviyoConnection(supabase, shopId) {
  const rows = await supabaseSelect(
    supabase,
    KLAVIYO_T.CONNECTIONS,
    { shop_id: shopId },
    'key_hint,conversion_metric_id,saved_at,last_sync_at,last_sync_status,last_sync_error',
    { limit: 1 }
  );
  return rows?.[0] ?? null;
}

/**
 * Pull flows and campaigns into Supabase.
 *
 * FLOWS: the first run backfills a year of days (seven requests, since a daily
 * series is capped at 60 days); every run after rewrites the last window only,
 * because that is where late conversions still land. CAMPAIGNS: one values
 * report over every campaign sent in the last year, named and dated from the
 * campaign list.
 *
 * NOT CONNECTED IS NOT AN ERROR: the nightly calls this for every shop and a
 * shop without a key is skipped. A failure is recorded on the connection row
 * (what /settings shows) and then thrown.
 */
export async function runKlaviyoSync({
  supabase,
  shopRow,
  dryRun = false,
  now = new Date(),
  log = console.log,
  createClient = createKlaviyoClient
}) {
  const connection = await readKlaviyoConnection(supabase, shopRow.id);
  if (!connection) return { skipped: 'not connected' };

  try {
    const key = await supabaseRpc(supabase, KLAVIYO_RPC.READ_KEY, { p_shop: shopRow.id });
    if (!key) throw new Error('The Klaviyo key is missing from Vault. Save it again on Settings → Integrations.');
    const klaviyo = createClient(key, { log });

    let metricId = connection.conversion_metric_id;
    if (!metricId) {
      metricId = pickConversionMetric(await klaviyo.listMetrics());
      if (!metricId) throw new Error('Klaviyo has no "Placed Order" metric on this account.');
    }

    const stored = await supabaseSelect(supabase, KLAVIYO_T.FLOW_DAYS, { shop_id: shopRow.id }, 'day', { limit: 1 });
    const days = stored?.length ? FLOW_WINDOW_DAYS : FLOW_BACKFILL_DAYS;

    let flowDays = 0;
    for (const window of flowWindows(now, days)) {
      const rows = foldFlowSeries(await klaviyo.flowSeriesReport(flowSeriesBody(window, metricId)), shopRow.id);
      flowDays += rows.length;
      if (!dryRun) await upsertChunks(supabase, KLAVIYO_T.FLOW_DAYS, stamp(rows, now), 'shop_id,flow_id,day');
    }

    const campaigns = [];
    for (const channel of ['email', 'sms']) {
      const list = await klaviyo.listCampaigns(channel).catch((error) => {
        // An account without SMS answers the email list fine; one missing
        // channel must not cost the other.
        log(`Klaviyo ${channel} campaigns not listed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      campaigns.push(...list.map((campaign) => ({ ...campaign, channel })));
    }
    const campaignRows = foldCampaigns(await klaviyo.campaignValuesReport(campaignValuesBody(now, metricId)), campaigns, shopRow.id);
    if (!dryRun) await upsertChunks(supabase, KLAVIYO_T.CAMPAIGNS, stamp(campaignRows, now), 'shop_id,campaign_id');

    const counts = { flow_days: flowDays, campaigns: campaignRows.length, backfill: days === FLOW_BACKFILL_DAYS };
    if (!dryRun) await recordSync(supabase, shopRow.id, { last_sync_at: now.toISOString(), last_sync_status: 'ok', last_sync_error: null });
    return counts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!dryRun) {
      await recordSync(supabase, shopRow.id, { last_sync_at: now.toISOString(), last_sync_status: 'failed', last_sync_error: message.slice(0, 500) }).catch(() => {});
    }
    throw error;
  }
}

function stamp(rows, now) {
  const fetchedAt = now.toISOString();
  return rows.map((row) => ({ ...row, fetched_at: fetchedAt }));
}

async function upsertChunks(supabase, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await supabaseUpsert(supabase, table, rows.slice(i, i + UPSERT_CHUNK), onConflict);
  }
}

function recordSync(supabase, shopId, fields) {
  return supabaseUpdate(supabase, KLAVIYO_T.CONNECTIONS, { shop_id: shopId }, fields);
}
