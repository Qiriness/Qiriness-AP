/**
 * How current each source feeding the Insights panels is, in words — and when
 * that is a problem.
 *
 * WHY THIS EXISTS. The panels re-query on every load, so they are never stale in
 * the caching sense; they are stale in the sense that matters, which is that the
 * JOBS feeding them stop. When the mail worker was last run on 20 August the
 * Support panel carried on drawing August for three weeks with nothing on the
 * screen to say so. A live dashboard is one that says how old its figures are.
 *
 * Pure: takes the `insights_freshness` row and a clock. The thresholds are the
 * judgement and live here, in one place, rather than in the view.
 */

export const FRESHNESS_RULES = Object.freeze({
  /** The order sync is nightly; past a day and a bit, a night was missed. */
  ordersStaleHours: 30,
  /** The mail worker is run by hand for now; two days without mail is a gap worth showing. */
  mailStaleHours: 48,
  /** A nightly run still `processing` after this long has died without closing its row. */
  syncStuckHours: 6,
  /** The topic map is rebuilt by hand; say its age, and flag it past a month. */
  topicMapStaleDays: 30
});

const HOUR = 3_600_000;

export function formatAgo(iso, now = new Date()) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

const ageHours = (iso, now) => (iso ? (now.getTime() - Date.parse(iso)) / HOUR : Infinity);

/**
 * The strip's items, in reading order. Each carries a tone: `ok` and `info` sit
 * quietly; `warn` and `error` are the ones a reader has to notice.
 */
export function describeFreshness(row, now = new Date(), rules = FRESHNESS_RULES) {
  if (!row) return [];
  const items = [];

  const ordersAt = row.orders_synced_at ?? null;
  items.push({
    id: 'orders',
    label: 'Orders',
    text: ordersAt ? `synced ${formatAgo(ordersAt, now)}` : 'never synced',
    tone: ageHours(ordersAt, now) > rules.ordersStaleHours ? 'warn' : 'ok',
    at: ordersAt
  });

  const mailAt = row.mail_synced_through ?? null;
  items.push({
    id: 'mail',
    label: 'Email',
    text: mailAt ? `last message ${formatAgo(mailAt, now)}` : 'never synced',
    tone: ageHours(mailAt, now) > rules.mailStaleHours ? 'warn' : 'ok',
    at: mailAt
  });

  const status = row.nightly_sync_status ?? null;
  if (status) {
    const started = row.nightly_sync_started_at ?? null;
    const finished = row.nightly_sync_finished_at ?? null;
    let text;
    let tone;
    if (status === 'processing') {
      const stuck = ageHours(started, now) > rules.syncStuckHours;
      text = stuck ? `started ${formatAgo(started, now)}, never finished` : `running since ${formatAgo(started, now)}`;
      tone = stuck ? 'error' : 'info';
    } else if (status === 'failed' || status === 'error') {
      text = `failed ${formatAgo(finished ?? started, now)}`;
      tone = 'error';
    } else {
      text = `${status} ${formatAgo(finished ?? started, now)}`;
      tone = 'ok';
    }
    items.push({ id: 'sync', label: 'Nightly sync', text, tone, at: finished ?? started });
  }

  const topicsAt = row.topic_map_built_at ?? null;
  if (topicsAt) {
    items.push({
      id: 'topics',
      label: 'Topic map',
      text: `built ${formatAgo(topicsAt, now)}`,
      tone: ageHours(topicsAt, now) > rules.topicMapStaleDays * 24 ? 'warn' : 'info',
      at: topicsAt
    });
  }

  return items;
}
