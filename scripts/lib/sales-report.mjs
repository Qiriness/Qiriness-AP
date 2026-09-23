/**
 * The monthly sales report as one self-contained HTML file — what the CEOs
 * download from Insights → Overview today, and what will be emailed to them at
 * the start of each month.
 *
 * PURE: data in, a string out. No database, no clock, no `fetch`. The web
 * route gathers the month (web/lib/server/insights/report-service.ts) and a
 * future mail job can call this with the same object; neither can make the
 * report say something the other would not.
 *
 * STATIC FIRST. Every figure is rendered on the server, for both comparisons,
 * so the file reads fully in a mail client that runs no script. The small
 * script at the end only adds the tabs and the MoM / YoY switch; without it,
 * every section shows one after another and the month-on-month deltas show.
 *
 * NOTHING IS INVENTED. A figure with no source (sessions, the funnel above the
 * purchase, Klaviyo, ads, social, delivery) renders as an em dash with the
 * reason, never as a zero or a mock-up; a comparison with no measured period
 * behind it is left out. Profitability is not in the report: no cost of goods,
 * shipping cost or ad spend reaches this app.
 *
 * Numbers are formatted here with en-GB grouping and a leading euro sign, the
 * layout the report was designed in.
 */

import { INVENTORY_STATUS_LABELS, averageOrderValue, revenueBridge, revenueDrivers } from './sales-overview.mjs';

/**
 * @typedef {{
 *   revenue: number, grossRevenue: number, paidOrders: number, units: number,
 *   discounts: number, discountedOrders: number, discountedRevenue: number, fullPriceRevenue: number,
 *   measured: number, over72h: number, p50Hours: number | null,
 *   refundedOrders: number, refundedAmount: number, cancelledOrders: number, returnsOpened: number,
 *   customers: null | { newCustomers: number, returningCustomers: number, newCustomerOrders: number, returningCustomerOrders: number },
 *   newsletter: null | { subscribed: number, unsubscribed: number, subscribersNow: number },
 *   sessions: number | null, visitors: number | null, conversionRate: number | null, bounceRate: number | null,
 *   cartSessions: number | null, checkoutSessions: number | null, convertedSessions: number | null,
 *   netSales: number | null, grossSales: number | null, ladderDiscounts: number | null,
 *   ladderReturns: number | null, taxes: number | null, shipping: number | null,
 *   totalSales: number | null, shopifyOrders: number | null, averageOrderValue: number | null,
 *   storefrontRevenue: number | null
 * }} ReportPeriod
 *
 * @typedef {{
 *   month: string, label: string, inProgress: boolean, generatedAt: string, timezone: string,
 *   compare: { mom: string, yoy: string, six: string, sixLabel: string },
 *   periods: { current: ReportPeriod, mom: ReportPeriod | null, yoy: ReportPeriod | null, six: ReportPeriod | null, sixPrevious: ReportPeriod | null },
 *   collections: { collectionId: string | null, title: string, products: number, orders: number, revenue: number, previousRevenue: number | null }[],
 *   productRevenue: number,
 *   trend: { key: string, label: string, revenue: number | null, orders: number | null }[],
 *   platforms: { label: string, revenue: number, orders: number }[],
 *   products: { title: string, revenue: number, orders: number, units: number, previousRevenue: number | null }[],
 *   promotions: { name: string | null, kind: string | null, target: string | null, orders: number, revenue: number, discount: number, newCustomerOrders: number | null }[],
 *   funnel: { key: string, label: string, value: number | null, ofEntry: number | null, ofPrevious: number | null }[],
 *   channels: { channel: string, sessions: number | null, revenue: number | null, orders: number | null, conversionRate: number | null, revenuePerSession: number | null }[],
 *   channelsBlockedReason: string | null,
 *   inventory: { items: { title: string, stock: number, unitsOut: number, coverDays: number | null, status: string }[], windowDays: number, syncedAt: string | null },
 *   carriers: { carrier: string, shipments: number, p50Hours: number | null, over72h: number }[],
 *   signals: { tone: string, title: string, detail: string }[]
 * }} SalesReportData
 */

// --- formatting -----------------------------------------------------------------

const GROUPED = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(value, cents = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  const text = cents
    ? abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : GROUPED.format(Math.round(abs));
  return `${sign}€${text}`;
}

const num = (value) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : GROUPED.format(Math.round(value)));
const pct = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`);
const pctOf = (period, key, digits = 1) => (period ? pct(period[key], digits) : '—');
const share = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);
const hoursText = (h) => (h === null || h === undefined || !Number.isFinite(h) ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

function rel(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  // Nothing then and nothing now is no change; something against nothing has no percentage.
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * One delta chip. `points` for a rate (percentage-point difference),
 * `absolute` for a count that can go negative — a newsletter's net, where a
 * percentage of a negative baseline reads backwards — else a relative change.
 * `polarity` says whether up is good. "No comparison" when there is nothing
 * honest to compare with.
 */
function deltaChip(value, { points = false, absolute = false, polarity = 'up' } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '<span class="delta flat">no comparison</span>';
  const flat = Math.abs(value) < 0.05;
  const good = polarity === 'up' ? value > 0 : value < 0;
  const cls = flat || polarity === 'neutral' ? 'flat' : good ? 'up' : 'down';
  const arrow = flat ? '→' : value > 0 ? '↑' : '↓';
  const size = absolute ? num(Math.abs(value)) : `${Math.abs(value).toFixed(1)}${points ? ' pts' : '%'}`;
  return `<span class="delta ${cls}">${arrow} ${size}</span>`;
}

/**
 * The same chip against each comparison; CSS shows the one the switch selects.
 *
 * MoM AND YoY COMPARE THE MONTH. 6M compares the six months ending with it
 * against the six before, so its FIGURE differs too — `values()` below renders
 * that, and the two must be switched together or the card would show a month's
 * revenue against a half-year's change.
 */
function deltas(current, mom, yoy, options = {}, six = undefined, sixPrevious = undefined) {
  const diff = (value, other) =>
    value === null || value === undefined || other === null || other === undefined
      ? null
      : options.points || options.absolute
        ? value - other
        : rel(value, other);
  const sixChip = six === undefined ? deltaChip(null, options) : deltaChip(diff(six, sixPrevious), options);
  return [
    `<span data-cmp="mom">${deltaChip(diff(current, mom), options)}</span>`,
    `<span data-cmp="yoy">${deltaChip(diff(current, yoy), options)}</span>`,
    `<span data-cmp="six">${sixChip}</span>`
  ].join('');
}

/** A figure that changes with the switch: the month's, and the six months'. */
function values(month, six) {
  return `<span data-cmp="mom">${month}</span><span data-cmp="yoy">${month}</span><span data-cmp="six">${six}</span>`;
}

// --- derived figures ------------------------------------------------------------

// SHOPIFY'S AOV, which is (gross sales − discounts) ÷ orders. `p.revenue` is
// Shopify's TOTAL sales — VAT and shipping included — so dividing it by orders
// read ~25% high against the admin. The fallback keeps a figure on the page
// when Shopify cannot be read, and the card says which one it is.
/** Shopify's total sales for a period, falling back to ours if it could not be read. */
const totalOf = (p) => (p ? (p.totalSales ?? p.revenue) : null);

const aovOf = (p) => (p ? (p.averageOrderValue ?? averageOrderValue(p.revenue, p.paidOrders)) : null);
const refundRateOf = (p) => (p && p.grossRevenue > 0 ? ((p.grossRevenue - p.revenue) / p.grossRevenue) * 100 : null);
const lateShareOf = (p) => (p && p.measured > 0 ? (p.over72h / p.measured) * 100 : null);
const discountShareOf = (p) => (p ? share(p.discounts, p.grossRevenue + p.discounts) : null);
const netSubscribersOf = (p) => (p && p.newsletter ? p.newsletter.subscribed - p.newsletter.unsubscribed : null);

// --- sections -------------------------------------------------------------------

function kpiCard(label, value, deltaHtml, blocked) {
  if (blocked) {
    return `<article class="card kpi blocked"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">—</div><span class="delta flat">${escapeHtml(blocked)}</span></article>`;
  }
  return `<article class="card kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div>${deltaHtml}</article>`;
}

function kpis(data) {
  const { current: c, mom: m, yoy: y, six: s6, sixPrevious: p6 } = data.periods;
  const cards = [
    // SHOPIFY'S OWN TOTAL where it answered. Our `revenue` is the same figure —
    // both are total sales — but ours subtracts a refund from the order it was
    // issued against while Shopify dates it to the refund, so a month with
    // returns differs by a few euros (August 2025: 17,598.78 against 17,656).
    // The report is read beside the admin, so the admin's number wins here, and
    // it keeps the card consistent with the bridge below it.
    kpiCard(
      'Total sales',
      values(money(totalOf(c)), money(totalOf(s6))),
      deltas(totalOf(c), totalOf(m), totalOf(y), {}, totalOf(s6), totalOf(p6))
    ),
    kpiCard(
      'Net sales',
      values(money(c.netSales), money(s6?.netSales)),
      deltas(c.netSales, m?.netSales, y?.netSales, {}, s6?.netSales, p6?.netSales),
      c.netSales === null ? 'Shopify Analytics could not be read' : undefined
    ),
    kpiCard('Orders', values(num(c.paidOrders), num(s6?.paidOrders)), deltas(c.paidOrders, m?.paidOrders, y?.paidOrders, {}, s6?.paidOrders, p6?.paidOrders)),
    kpiCard('Units sold', values(num(c.units), num(s6?.units)), deltas(c.units, m?.units, y?.units, {}, s6?.units, p6?.units)),
    kpiCard('AOV', values(money(aovOf(c), true), money(aovOf(s6), true)), deltas(aovOf(c), aovOf(m), aovOf(y), {}, aovOf(s6), aovOf(p6))),
    kpiCard(
      'Refund rate',
      values(pct(refundRateOf(c)), pct(refundRateOf(s6))),
      deltas(refundRateOf(c), refundRateOf(m), refundRateOf(y), { points: true, polarity: 'down' }, refundRateOf(s6), refundRateOf(p6))
    ),
    kpiCard(
      'Sessions',
      values(num(c.sessions), num(s6?.sessions)),
      deltas(c.sessions, m?.sessions, y?.sessions, {}, s6?.sessions, p6?.sessions),
      c.sessions === null ? 'Shopify Analytics could not be read' : undefined
    ),
    kpiCard(
      'Conversion',
      values(pct(c.conversionRate, 2), pct(s6?.conversionRate, 2)),
      deltas(c.conversionRate, m?.conversionRate, y?.conversionRate, { points: true }, s6?.conversionRate, p6?.conversionRate),
      c.conversionRate === null ? 'Shopify Analytics could not be read' : undefined
    )
  ];
  return `<div class="kpis">${cards.join('')}</div>`;
}

/** A 12-month line, drawn as inline SVG so it survives any mail client that shows images. */
function trendSvg(points, metric) {
  const w = 700;
  const h = 215;
  const p = { l: 52, r: 14, t: 12, b: 28 };
  const values = points.map((x) => x[metric]);
  const measured = values.filter((v) => v !== null && Number.isFinite(v));
  if (measured.length === 0) return '<p class="muted">No orders in these twelve months.</p>';
  const hi = Math.max(...measured) * 1.06 || 1;
  const x = (i) => p.l + (i * (w - p.l - p.r)) / Math.max(1, points.length - 1);
  const y = (v) => p.t + ((hi - v) * (h - p.t - p.b)) / hi;
  let grid = '';
  for (let i = 0; i < 4; i += 1) {
    const yy = p.t + (i * (h - p.t - p.b)) / 3;
    const v = hi - (i * hi) / 3;
    const label = metric === 'revenue' ? `€${GROUPED.format(Math.round(v / 1000))}k` : GROUPED.format(Math.round(v));
    grid += `<line class="axis" x1="${p.l}" y1="${yy.toFixed(1)}" x2="${w - p.r}" y2="${yy.toFixed(1)}"/><text class="axis-label" x="${p.l - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${label}</text>`;
  }
  // A month with no data breaks the line rather than dropping it to zero.
  const segments = [];
  let run = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) segments.push(run);
      run = [];
    } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length) segments.push(run);
  const lines = segments.map((s) => `<polyline class="line" points="${s.join(' ')}"/>`).join('');
  const dots = values
    .map((v, i) =>
      v === null || !Number.isFinite(v)
        ? ''
        : `<circle class="point" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.3"><title>${escapeHtml(points[i].label)} · ${metric === 'revenue' ? money(v) : num(v)}</title></circle>`
    )
    .join('');
  const labels = points
    .map((pt, i) => `<text class="axis-label" x="${x(i).toFixed(1)}" y="${h - 7}" text-anchor="middle">${escapeHtml(pt.label)}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${metric === 'revenue' ? 'Revenue' : 'Orders'}, twelve months">${grid}${lines}${dots}${labels}</svg>`;
}

function driverRow(label, hint, value, blocked) {
  if (blocked) {
    return `<div class="driver-row"><div class="driver-label"><b>${label}</b><span>${hint}</span></div><div class="bar blocked"></div><div class="driver-val flat" title="${escapeHtml(blocked)}">—</div></div>`;
  }
  if (value === null) {
    return `<div class="driver-row"><div class="driver-label"><b>${label}</b><span>${hint}</span></div><div class="bar"></div><div class="driver-val flat">—</div></div>`;
  }
  const width = Math.min(100, Math.max(3, Math.abs(value) * 4));
  return `<div class="driver-row"><div class="driver-label"><b>${label}</b><span>${hint}</span></div><div class="bar"><i class="${value < 0 ? 'neg' : ''}" style="width:${width.toFixed(1)}%"></i></div><div class="driver-val ${value >= 0 ? 'up' : 'down'}">${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%</div></div>`;
}

function driversFor(current, other, label) {
  // `other` carries the storefront figures too, so the traffic rows compare
  // against the same period as the money rows.
  const d = revenueDrivers(
    { revenue: current.revenue, paidOrders: current.paidOrders },
    other ? { revenue: other.revenue, paidOrders: other.paidOrders } : null
  );
  const f = (v) => (v === null ? null : v * 100);
  const total = f(d.total);
  const lead =
    d.lead === null
      ? 'No measured period to compare with.'
      : `<b>${d.lead === 'orders' ? 'Order volume' : 'Average order value'} moved most</b> vs ${escapeHtml(label)}. Orders × AOV covers the whole business; sessions and conversion are Shopify's storefront figures and do not multiply out to it, because a marketplace order has no session.`;
  return `<div class="driver-total"><span>Total revenue change</span><strong class="${total === null ? 'flat' : total >= 0 ? 'up' : 'down'}">${total === null ? '—' : `${total >= 0 ? '+' : '−'}${Math.abs(total).toFixed(1)}%`}</strong></div>
<div class="drivers">${driverRow('Orders', 'Volume', f(d.orders))}${driverRow('AOV', 'Basket', f(d.aov))}${driverRow('Sessions', 'Traffic · storefront', rel(current.sessions, other?.sessions))}${driverRow('Conversion', 'Efficiency · storefront', rel(current.conversionRate, other?.conversionRate))}</div>
<div class="callout">${lead}</div>`;
}

/**
 * Shopify's ladder as HORIZONTAL rows (the owner's layout, 2026-09-23): the
 * label reads on the left, the bar runs to the right, and the figure ends the
 * row. Six vertical columns made the small steps unreadable and forced the
 * labels to wrap.
 */
function bridge(c) {
  if (c.grossSales === null) {
    return '<p class="muted">Shopify Analytics could not be read, so the sales ladder is not shown.</p>';
  }
  // A real chain, read left to right:
  //   total − (VAT + shipping)    = net sales
  //   net   + discounts + returns = gross sales
  const steps = [
    ['Total sales', c.totalSales, ''],
    ['VAT & shipping', (c.taxes ?? 0) + (c.shipping ?? 0), 'neg'],
    ['Net sales', c.netSales, ''],
    ['Discounts', c.ladderDiscounts ?? 0, 'add'],
    ['Returns', c.ladderReturns ?? 0, 'add'],
    ['Gross sales', c.grossSales, 'gold']
  ];
  const max = Math.max(1, c.grossSales, c.totalSales ?? 0);
  return `<div class="bridge">${steps
    .map(
      ([label, value, cls]) =>
        `<div class="bridge-row ${cls}"><span class="bridge-label">${escapeHtml(label)}</span><span class="bridge-track"><i style="width:${Math.max(1.5, ((value ?? 0) / max) * 100).toFixed(1)}%"></i></span><b>${value > 0 && cls === 'neg' ? '−' : value > 0 && cls === 'add' ? '+' : ''}${money(value)}</b></div>`
    )
    .join('')}</div>
<div class="footer-note">Reads left to right: total sales less VAT (${money(c.taxes)}) and shipping (${money(c.shipping)}) is net sales; adding back discounts and returns gives gross sales, the value of the goods before any reduction.</div>`;
}

function signals(list) {
  if (!list.length) return '<p class="muted">No signal for this month.</p>';
  return `<div class="insights">${list
    .map(
      (s, i) =>
        `<div class="insight ${s.tone === 'warn' ? 'warn' : s.tone === 'neutral' ? 'neutral' : ''}"><i>${String(i + 1).padStart(2, '0')}</i><div><b>${escapeHtml(s.title)}</b>${s.detail ? `<span>${escapeHtml(s.detail)}</span>` : ''}</div></div>`
    )
    .join('')}</div>`;
}

function hbars(rows, total) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map(
      (r) =>
        `<div class="hbar-row"><span title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span><div class="bar"><i style="width:${((r.value / max) * 100).toFixed(1)}%"></i></div><b>${total > 0 ? `${((r.value / total) * 100).toFixed(0)}%` : '—'}</b></div>`
    )
    .join('');
}

function overview(data) {
  const c = data.periods.current;
  const platformTotal = data.platforms.reduce((s, p) => s + p.revenue, 0);
  return `<section class="view active" id="view-overview">
${kpis(data)}
<div class="grid2">
  <article class="card panel"><div class="panel-head"><div><h2>Performance trend</h2><div class="hint">12 months ending ${escapeHtml(data.label)}</div></div><div class="metric-tabs" data-tabs="trend"><button class="active" data-show="trend-revenue">Revenue</button><button data-show="trend-orders">Orders</button></div></div>
    <div class="chart" data-pane="trend" id="trend-revenue">${trendSvg(data.trend, 'revenue')}</div>
    <div class="chart" data-pane="trend" id="trend-orders">${trendSvg(data.trend, 'orders')}</div>
  </article>
  <article class="card panel"><div class="panel-head"><div><h2>What moved revenue?</h2><div class="hint">Revenue = orders × AOV</div></div></div>
    <div data-cmp="mom">${driversFor(c, data.periods.mom, data.compare.mom)}</div>
    <div data-cmp="yoy">${driversFor(c, data.periods.yoy, data.compare.yoy)}</div>
    <div data-cmp="six">${data.periods.six ? driversFor(data.periods.six, data.periods.sixPrevious, data.compare.six) : '<p class="muted">Not enough history for a six-month comparison.</p>'}</div>
  </article>
</div>
<div class="grid3">
  <article class="card panel"><div class="panel-head"><div><h2>Sales bridge</h2><div class="hint">Shopify's own figures, top line to bottom line</div></div></div>${bridge(c)}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Management signals</h2><div class="hint">Rule-based exceptions vs ${escapeHtml(data.compare.mom)}, not AI</div></div></div>${signals(data.signals)}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Sales mix</h2><div class="hint">Where the month's revenue came from</div></div></div>${hbars(
    data.platforms.map((p) => ({ label: p.label, value: p.revenue })),
    platformTotal
  )}</article>
</div>
</section>`;
}

function newsletterCard(data) {
  const { current: c, mom: m, yoy: y } = data.periods;
  if (!c.newsletter) {
    return `<article class="card panel"><div class="panel-head"><div><h2>Newsletter subscribers</h2><div class="hint">Gained and lost in the month</div></div></div><p class="muted">Not measurable for this month: Shopify's consent record holds no unsubscribe this early, so losses would read as zero.</p></article>`;
  }
  const n = c.newsletter;
  const net = n.subscribed - n.unsubscribed;
  // Gained and lost compare as percentages; net can be negative, so it compares in people.
  const row = (label, value, mv, yv, polarity, absolute = false) => {
    const d = ([a, b]) => (b === null || b === undefined ? null : absolute ? a - b : rel(a, b));
    return `<tr><td><b>${label}</b></td><td>${value}</td><td>${deltaChip(d(mv), { polarity, absolute })}</td><td>${deltaChip(d(yv), { polarity, absolute })}</td></tr>`;
  };
  const mn = m?.newsletter ?? null;
  const yn = y?.newsletter ?? null;
  const total = n.subscribed + n.unsubscribed;
  return `<article class="card panel"><div class="panel-head"><div><h2>Newsletter subscribers</h2><div class="hint">Gained and lost in the month · Shopify customers</div></div><span class="pill ${net >= 0 ? '' : 'negative'}">Net ${net >= 0 ? '+' : '−'}${num(Math.abs(net))}</span></div>
<div class="splitbar"><i style="width:${total > 0 ? ((n.subscribed / total) * 100).toFixed(1) : 50}%;background:var(--green2)"></i><i style="width:${total > 0 ? ((n.unsubscribed / total) * 100).toFixed(1) : 50}%;background:var(--rose)"></i></div>
<table><thead><tr><th></th><th>${escapeHtml(data.label)}</th><th>vs ${escapeHtml(data.compare.mom)}</th><th>vs ${escapeHtml(data.compare.yoy)}</th></tr></thead><tbody>
${row('Gained', `+${num(n.subscribed)}`, [n.subscribed, mn?.subscribed], [n.subscribed, yn?.subscribed], 'up')}
${row('Lost', `−${num(n.unsubscribed)}`, [n.unsubscribed, mn?.unsubscribed], [n.unsubscribed, yn?.unsubscribed], 'down')}
${row('Net', `${net >= 0 ? '+' : '−'}${num(Math.abs(net))}`, [net, mn ? mn.subscribed - mn.unsubscribed : null], [net, yn ? yn.subscribed - yn.unsubscribed : null], 'up', true)}
</tbody></table>
<div class="footer-note">${num(n.subscribersNow)} on the list at generation. Read from each customer's current consent and when it last changed, so both figures are floors: someone who joined and left in the same month counts once, as a loss.</div></article>`;
}

function customersAndProducts(data) {
  const { current: c, mom: m } = data.periods;
  const mix = c.customers;
  const mixHtml = mix
    ? (() => {
        const orders = mix.newCustomerOrders + mix.returningCustomerOrders;
        const people = mix.newCustomers + mix.returningCustomers;
        const newShare = share(mix.newCustomerOrders, orders) ?? 50;
        return `<div class="splitbar"><i style="width:${newShare.toFixed(1)}%"></i><i style="width:${(100 - newShare).toFixed(1)}%"></i></div>
<table><thead><tr><th>Segment</th><th>Customers</th><th>Orders</th><th>Share of orders</th></tr></thead><tbody>
<tr><td><b>New</b></td><td>${num(mix.newCustomers)}</td><td>${num(mix.newCustomerOrders)}</td><td>${pct(share(mix.newCustomerOrders, orders), 0)}</td></tr>
<tr><td><b>Returning</b></td><td>${num(mix.returningCustomers)}</td><td>${num(mix.returningCustomerOrders)}</td><td>${pct(share(mix.returningCustomerOrders, orders), 0)}</td></tr>
</tbody></table><div class="legend"><span><i class="swatch gold"></i>New</span><span><i class="swatch green"></i>Returning</span><span>${num(people)} Shopify customers ordered</span></div>`;
      })()
    : '<p class="muted">No Shopify customer ordered this month.</p>';
  const strip = mix
    ? [
        ['New customers', num(mix.newCustomers), m?.customers ? deltaChip(rel(mix.newCustomers, m.customers.newCustomers)) : ''],
        ['Returning customers', num(mix.returningCustomers), m?.customers ? deltaChip(rel(mix.returningCustomers, m.customers.returningCustomers)) : ''],
        ['Returning share of orders', pct(share(mix.returningCustomerOrders, mix.newCustomerOrders + mix.returningCustomerOrders)), ''],
        ['Orders per customer', (mix.newCustomers + mix.returningCustomers) > 0 ? `${((mix.newCustomerOrders + mix.returningCustomerOrders) / (mix.newCustomers + mix.returningCustomers)).toFixed(2)}×` : '—', '']
      ]
    : [];
  const products = data.products
    .map((p, i) => {
      const diff = p.previousRevenue === null ? null : p.revenue - p.previousRevenue;
      const change = rel(p.revenue, p.previousRevenue);
      return `<tr><td><span class="rank">${i + 1}</span><b>${escapeHtml(p.title)}</b></td><td>${money(p.revenue)}</td><td class="${diff === null ? 'flat' : diff >= 0 ? 'up' : 'down'}">${diff === null ? '—' : `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}`}</td><td>${change === null ? '<span class="pill">new</span>' : `<span class="pill ${change < 0 ? 'negative' : ''}">${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%</span>`}</td><td>${num(p.orders)}</td><td>${num(p.units)}</td></tr>`;
    })
    .join('');
  return `<section class="view" id="view-customers">
${strip.length ? `<div class="stat-strip">${strip.map(([l, v, d]) => `<div class="mini"><span>${l}</span><strong>${v}</strong>${d ? `<em>${d} vs ${escapeHtml(data.compare.mom)}</em>` : ''}</div>`).join('')}</div>` : ''}
<div class="grid2 equal">
  <article class="card panel"><div class="panel-head"><div><h2>New vs returning customers</h2><div class="hint">Shopify customers; marketplaces create a customer per order and are left out</div></div></div>${mixHtml}</article>
  ${newsletterCard(data)}
</div>
<div class="grid-wide">
<article class="card panel"><div class="panel-head"><div><h2>Product performance</h2><div class="hint">Top products by net line revenue, vs ${escapeHtml(data.compare.mom)} · samples and gifts excluded</div></div></div>
${data.products.length ? `<table><thead><tr><th>Product</th><th>Revenue</th><th>Δ €</th><th>Δ %</th><th>Orders</th><th>Units</th></tr></thead><tbody>${products}</tbody></table>` : '<p class="muted">No product sold this month.</p>'}
</article>
${collectionMix(data)}
</div>
</section>`;
}

/**
 * The six ranges the catalogue is managed by, and everything outside them.
 * A product counts in every range that carries it, so the shares overlap and
 * never sum to 100% — the note says so, and nothing here adds them up.
 */
function collectionMix(data) {
  const rows = data.collections ?? [];
  if (rows.length === 0) return '';
  // Share is of ALL paid product revenue in the period. Summing the rows would
  // be wrong twice over: they overlap, and the last row is what they exclude.
  const denominator = data.productRevenue ?? 0;
  const named = rows.filter((r) => r.collectionId !== null);
  const widest = Math.max(1, ...named.map((r) => r.revenue));
  const line = (r) => {
    const share = denominator > 0 ? pct((r.revenue / denominator) * 100) : '—';
    const change =
      r.previousRevenue === null
        ? '<span class="muted">—</span>'
        : r.previousRevenue === 0
          ? '<span class="pill">new</span>'
          : deltaChip(rel(r.revenue, r.previousRevenue));
    return `<tr${r.collectionId === null ? ' class="muted"' : ''}><td><b>${escapeHtml(r.title)}</b></td><td>${money(r.revenue)}</td><td>${share}</td><td>${change}</td></tr>`;
  };
  return `<article class="card panel"><div class="panel-head"><div><h2>Collection mix</h2><div class="hint">The ranges the catalogue is managed by</div></div></div>
<table><thead><tr><th>Collection</th><th>Revenue</th><th>Share</th><th>Δ</th></tr></thead><tbody>${rows.map(line).join('')}</tbody></table>
<div class="concentration">${named.map((r) => `<i style="width:${Math.max(2, (r.revenue / widest) * 100).toFixed(1)}%"></i>`).join('')}</div>
<div class="footer-note">A product counts in every range that carries it, so the shares overlap and never add up to 100%. Share is of the period's paid product revenue; anything in none of the ranges is the last row.</div></article>`;
}

function marketing(data) {
  const c = data.periods.current;
  const funnel = (data.funnel ?? [])
    .map((step, i) => {
      const under =
        i === 0
          ? 'entry · human sessions'
          : step.chained === false
            ? 'entries, not views · outside the chain'
            : `${step.ofPrevious === null ? '—' : pct(step.ofPrevious)} from prior step`;
      return `<div class="funnel-row"><label>${escapeHtml(step.label)}<small>${under}</small></label><div class="funnel-bar${step.chained === false ? ' aside' : ''}"><i style="--w:${step.ofEntry === null ? 0 : Math.max(2, step.ofEntry).toFixed(1)}%"></i></div><div class="funnel-val"><b>${num(step.value)}</b><small>${step.ofEntry === null ? 'not measured' : `${pct(step.ofEntry)} of entry`}</small></div></div>`;
    })
    .join('');
  const promos = data.promotions
    .map(
      (p) =>
        `<tr><td><b>${escapeHtml(p.name ?? 'No promotion (full price)')}</b>${p.kind === 'code' ? '<span class="sub">code</span>' : ''}</td><td>${money(p.revenue)}</td><td>${num(p.orders)}</td><td>${money(p.orders > 0 ? p.revenue / p.orders : null, true)}</td><td>${p.name === null ? '—' : p.target === 'SHIPPING_LINE' ? 'shipping' : money(p.discount)}</td><td>${p.newCustomerOrders === null ? '—' : num(p.newCustomerOrders)}</td></tr>`
    )
    .join('');
  const fullPriceOrders = c.paidOrders - c.discountedOrders;
  return `<section class="view" id="view-marketing">
<div class="grid2 equal">
  <article class="card panel"><div class="panel-head"><div><h2>E-commerce funnel</h2><div class="hint">Stage conversion and largest leakage</div></div><span class="pill${c.conversionRate === null ? ' warn' : ''}">CVR ${c.conversionRate === null ? '—' : pct(c.conversionRate, 2)}</span></div>
    <div class="funnel">${funnel}</div>
    <div class="callout"><b>Every step counts sessions, not orders.</b> The last step over the first is Shopify's conversion rate. Our own ${num(c.paidOrders)} paid orders is a larger number because it counts every platform, including marketplace orders that never had a session. <b>Product views are not measurable</b> — Shopify keeps no such metric — so the product row counts sessions that <i>arrived</i> on a product page; it sits outside the chain, and the cart step below is measured against sessions, not against it.</div></article>
  <article class="card panel"><div class="panel-head"><div><h2>Acquisition channels</h2><div class="hint">Shopify's own attribution, both sides on referring_channel</div></div></div>${channelTable(data)}</article>
</div>
<div class="grid2">
  <article class="card panel"><div class="panel-head"><div><h2>Marketing performance</h2><div class="hint">Owned, paid and organic demand</div></div></div>
    <div class="marketing-summary"><div class="ms"><span>Klaviyo revenue</span><strong>—</strong></div><div class="ms"><span>Ad spend</span><strong>—</strong></div><div class="ms"><span>ROAS</span><strong>—</strong></div><div class="ms"><span>Social reach</span><strong>—</strong></div></div>
    ${blockedTable(['Source', 'Spend', 'Revenue', 'ROAS', 'Conversion'], 'Klaviyo, Google Ads, Meta Ads, Instagram and TikTok are not connected yet.')}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Promotions &amp; discounting</h2><div class="hint">What each promotion recorded on its orders</div></div></div>
    ${data.promotions.length ? `<table><thead><tr><th>Promotion</th><th>Revenue</th><th>Orders</th><th>AOV</th><th>Discount</th><th>New cust.</th></tr></thead><tbody>${promos}</tbody></table>` : '<p class="muted">No order this month.</p>'}
    <div class="callout"><b>Full-price revenue:</b> ${money(c.fullPriceRevenue)} · <b>Discounted-order AOV:</b> ${money(c.discountedOrders > 0 ? c.discountedRevenue / c.discountedOrders : null, true)} · <b>Full-price AOV:</b> ${money(fullPriceOrders > 0 ? c.fullPriceRevenue / fullPriceOrders : null, true)}</div>
    <div class="footer-note">An order with two promotions counts in both rows. Gifts are valued at list price; discounts &amp; gifts were ${pct(discountShareOf(c))} of gross sales.</div></article>
</div>
</section>`;
}

/** A table that exists to show its columns, with the reason its cells are empty. */
function blockedTable(head, reason) {
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${head.length}" class="pending">${reason}</td></tr></tbody></table>`;
}

/** Traffic and money per channel, or the reason there is none. */
function channelTable(data) {
  if (!data.channels || data.channels.length === 0) {
    return blockedTable(
      ['Channel', 'Sessions', 'Revenue', 'Orders', 'CVR', 'Rev/session'],
      escapeHtml(data.channelsBlockedReason ?? 'Shopify Analytics reported no traffic this month.')
    );
  }
  const dash = '<span class="muted">—</span>';
  return `<table><thead><tr><th>Channel</th><th>Sessions</th><th>Revenue</th><th>Orders</th><th>CVR</th><th>Rev/session</th></tr></thead><tbody>${data.channels
    .map(
      (ch) =>
        `<tr><td><b>${escapeHtml(ch.channel)}</b></td><td>${ch.sessions === null ? dash : num(ch.sessions)}</td><td>${ch.revenue === null ? dash : money(ch.revenue)}</td><td>${ch.orders === null ? dash : num(ch.orders)}</td><td>${ch.conversionRate === null ? dash : pct(ch.conversionRate, 2)}</td><td>${ch.revenuePerSession === null ? dash : money(ch.revenuePerSession, true)}</td></tr>`
    )
    .join('')}</tbody></table><div class="footer-note">Revenue here is Shopify's attribution and can differ from the revenue elsewhere in this report, which is this dashboard's own. A channel with traffic and no orders, or revenue and no recorded sessions, keeps its figure rather than being filled with a zero.</div>`;
}

function operations(data) {
  const { current: c, mom: m, yoy: y } = data.periods;
  const inv = data.inventory;
  const carrierTotal = data.carriers.reduce((s, x) => s + x.shipments, 0);
  const cards = [
    ['Median time to ship', hoursText(c.p50Hours), deltas(c.p50Hours, m?.p50Hours, y?.p50Hours, { polarity: 'down' })],
    ['Shipped after 3 days', pct(lateShareOf(c)), deltas(lateShareOf(c), lateShareOf(m), lateShareOf(y), { points: true, polarity: 'down' })],
    ['Refunded orders', num(c.refundedOrders), `<span class="delta flat">${money(c.refundedAmount)} refunded</span>`],
    ['Cancelled orders', num(c.cancelledOrders), deltas(c.cancelledOrders, m?.cancelledOrders, y?.cancelledOrders, { polarity: 'down' })]
  ];
  const statusClass = (s) => (s === 'out' || s === 'critical' ? 'negative' : s === 'low' ? 'warn' : '');
  const synced = inv.syncedAt ? inv.syncedAt.slice(0, 10) : 'never';
  return `<section class="view" id="view-operations">
<div class="ops-cards">${cards.map(([l, v, d]) => `<article class="card op-card"><span>${l}</span><strong>${v}</strong>${d}</article>`).join('')}</div>
<div class="grid3">
  <article class="card panel"><div class="panel-head"><div><h2>Inventory exceptions</h2><div class="hint">Active products, stock as of ${escapeHtml(synced)} · cover at the last ${inv.windowDays} days' rate</div></div></div>
    ${inv.items.length ? `<table><thead><tr><th>Product</th><th>Stock</th><th>Days</th><th>Status</th></tr></thead><tbody>${inv.items
      .slice(0, 10)
      .map(
        (i) =>
          `<tr><td><b>${escapeHtml(i.title)}</b></td><td>${num(i.stock)}</td><td>${i.coverDays === null ? '—' : Math.floor(i.coverDays)}</td><td><span class="pill ${statusClass(i.status)}">${escapeHtml(INVENTORY_STATUS_LABELS[i.status] ?? i.status)}</span></td></tr>`
      )
      .join('')}</tbody></table>` : `<p class="muted">No active product is out of stock or under ${inv.windowDays} days of cover.</p>`}
    <div class="footer-note">Stock is now, not at month end: Shopify keeps no stock history this app reads. No replenishment is shown — purchase orders do not reach it.</div></article>
  <article class="card panel"><div class="panel-head"><div><h2>Carrier performance</h2><div class="hint">Dispatch by carrier · delivery not measured yet</div></div></div>
    ${data.carriers.length ? `<table><thead><tr><th>Carrier</th><th>Shipments</th><th>Share</th><th>Median to ship</th><th>After 3 days</th></tr></thead><tbody>${data.carriers
      .map(
        (x) =>
          `<tr><td><b>${escapeHtml(x.carrier)}</b></td><td>${num(x.shipments)}</td><td>${pct(share(x.shipments, carrierTotal), 0)}</td><td>${hoursText(x.p50Hours)}</td><td>${pct(share(x.over72h, x.shipments))}</td></tr>`
      )
      .join('')}</tbody></table>` : '<p class="muted">No shipment this month.</p>'}
    <div class="footer-note">On-time delivery and failed deliveries need a carrier feed; none reaches Shopify yet.</div></article>
  <article class="card panel"><div class="panel-head"><div><h2>Returns &amp; refunds</h2><div class="hint">What Shopify recorded</div></div></div>
    <table><tbody>
      <tr><td><b>Refunded orders</b></td><td>${num(c.refundedOrders)}</td></tr>
      <tr><td><b>Amount refunded</b></td><td>${money(c.refundedAmount)}</td></tr>
      <tr><td><b>Returns opened</b></td><td>${num(c.returnsOpened)}</td></tr>
      <tr><td><b>Refund rate</b></td><td>${pct(refundRateOf(c))}</td></tr>
    </tbody></table>
    <div class="footer-note">Refund reasons are not recorded in Shopify here, so there is no breakdown by cause. A refund agreed by email with no return raised reads as a refund without a return.</div></article>
</div>
</section>`;
}

// --- the page -------------------------------------------------------------------

const STYLE = `:root{--ink:#17211d;--muted:#6e7771;--line:#e8e3da;--paper:#faf9f6;--card:#fff;--green:#173f35;--green2:#2f7562;--gold:#bd9a58;--rose:#bd615c;--amber:#c68a3c;--wash:#f4eee4;--soft:#f7f5f0;--shadow:0 10px 30px rgba(30,43,37,.065);--r:17px}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}button{font:inherit}.shell{max-width:1260px;margin:auto;padding:26px}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:17px}.eyebrow{color:var(--gold);font-size:10px;font-weight:850;letter-spacing:.15em;text-transform:uppercase}h1{font:600 clamp(26px,3vw,38px)/1.08 Georgia,serif;margin:5px 0 4px}.subtitle,.muted{color:var(--muted)}.muted{font-size:12px;margin:0}
.controls{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:flex-end}.segmented{display:flex;padding:3px;background:#fff;border:1px solid var(--line);border-radius:11px;box-shadow:0 2px 8px rgba(0,0,0,.03)}.segmented button{border:0;background:transparent;color:var(--muted);padding:7px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}.segmented button.active{background:var(--green);color:#fff}.stamp{font-size:10px;color:var(--muted)}
.notice{display:flex;align-items:center;justify-content:space-between;gap:14px;background:var(--wash);border:1px solid #eadfcf;border-radius:12px;padding:9px 12px;margin-bottom:13px;color:#635c50;font-size:12px}.notice b{color:var(--ink)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--gold);margin-right:7px}
.report-nav{display:none;gap:5px;padding:5px;background:#ebe8e1;border-radius:13px;margin-bottom:13px;overflow:auto}.js .report-nav{display:flex}.report-nav button{flex:1;min-width:145px;border:0;background:transparent;color:#626a65;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700;font-size:12px}.report-nav button.active{background:white;color:var(--ink);box-shadow:0 2px 9px rgba(0,0,0,.08)}
.view{display:block;margin-bottom:22px}.js .view{display:none}.js .view.active{display:block}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}.panel{padding:18px;min-width:0;margin-bottom:13px}.grid2 .panel,.grid3 .panel{margin-bottom:0}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}h2{font-size:15px;margin:0 0 2px}.hint{font-size:11px;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:13px}.kpi{padding:15px;min-width:0}.kpi.blocked{background:repeating-linear-gradient(45deg,#fff 0 6px,#f7f5f0 6px 12px)}.kpi-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpi-value{font-size:21px;font-weight:750;letter-spacing:-.035em;margin:6px 0 3px}.delta{font-size:10px;font-weight:750}.up{color:var(--green2)}.down{color:#b8514d}.flat{color:var(--muted)}
[data-cmp="yoy"],[data-cmp="six"]{display:none}
body[data-compare="yoy"] [data-cmp="yoy"],body[data-compare="six"] [data-cmp="six"]{display:inline}
body[data-compare="yoy"] div[data-cmp="yoy"],body[data-compare="six"] div[data-cmp="six"]{display:block}
body[data-compare="yoy"] [data-cmp="mom"],body[data-compare="six"] [data-cmp="mom"]{display:none}
.grid-wide{display:grid;grid-template-columns:1.35fr .9fr;gap:13px;margin-bottom:13px}.grid-wide .panel{margin-bottom:0}
.grid2{display:grid;grid-template-columns:1.58fr 1fr;gap:13px;margin-bottom:13px}.grid2.equal{grid-template-columns:1fr 1fr}.grid3{display:grid;grid-template-columns:1fr 1.25fr 1fr;gap:13px;margin-bottom:13px}
.metric-tabs{display:flex;gap:3px;background:#f1efe9;padding:3px;border-radius:9px}.metric-tabs button{border:0;background:transparent;padding:6px 8px;border-radius:7px;color:var(--muted);font-size:10px;cursor:pointer;white-space:nowrap}.metric-tabs button.active{background:white;color:var(--ink);box-shadow:0 1px 5px rgba(0,0,0,.08)}.metric-tabs{display:none}.js .metric-tabs{display:flex}
.chart{height:225px}.chart+.chart{margin-top:10px}.js .chart+.chart{margin-top:0}.chart svg{width:100%;height:100%;overflow:visible}.axis{stroke:#ebe7df;stroke-width:1}.axis-label{fill:#8a8f8b;font-size:9px}.line{fill:none;stroke:var(--green);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.point{fill:#fff;stroke:var(--green);stroke-width:2}
.driver-total{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:11px;margin-bottom:12px}.driver-total strong{font-size:24px}.drivers{display:grid;gap:12px}.driver-row{display:grid;grid-template-columns:82px 1fr 48px;align-items:center;gap:8px}.driver-label b{display:block;font-size:11px}.driver-label span{font-size:9px;color:var(--muted)}.bar{height:7px;background:#eeeae3;border-radius:20px;overflow:hidden}.bar.blocked{background:repeating-linear-gradient(45deg,#eeeae3 0 4px,#fff 4px 8px)}.bar i{display:block;height:100%;border-radius:20px;background:var(--green2)}.bar i.neg{background:var(--rose)}.driver-val{text-align:right;font-size:11px;font-weight:800}.callout{background:var(--soft);border-radius:10px;padding:10px 11px;margin-top:13px;font-size:11px;color:#5f655f}.callout b{color:var(--ink)}
.bridge{display:grid;gap:9px}.bridge-row{display:grid;grid-template-columns:96px 1fr 84px;align-items:center;gap:9px}.bridge-label{font-size:10px;color:var(--muted)}.bridge-track{height:14px;background:#eeeae3;border-radius:20px;overflow:hidden}.bridge-track i{display:block;height:100%;border-radius:20px;background:var(--green)}.bridge-row.neg .bridge-track i{background:var(--rose)}.bridge-row.gold .bridge-track i{background:var(--gold)}.bridge-row.add .bridge-track i{background:var(--green2)}.bridge-row b{text-align:right;font-size:11px;font-variant-numeric:tabular-nums}
.insights{display:grid;gap:8px}.insight{display:grid;grid-template-columns:24px 1fr;gap:8px;padding:9px;background:var(--soft);border-radius:10px}.insight i{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:#e7efe9;color:var(--green2);font-style:normal;font-weight:850;font-size:10px}.insight.warn i{background:#f7e9e7;color:var(--rose)}.insight.neutral i{background:#eeeae3;color:var(--muted)}.insight b{display:block;font-size:11px}.insight span{display:block;color:var(--muted);font-size:10px;margin-top:1px}
table{width:100%;border-collapse:collapse}th{text-align:left;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:0 6px 7px;white-space:nowrap}td{padding:8px 6px;border-top:1px solid var(--line);font-size:11px}td:nth-child(n+2),th:nth-child(n+2){text-align:right}tr.muted td{color:var(--muted)}td.pending{text-align:center!important;color:var(--muted);background:repeating-linear-gradient(45deg,#fff 0 6px,#f7f5f0 6px 12px)}.rank{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:6px;background:#f1eee7;color:var(--muted);font-size:9px;margin-right:6px}.sub{display:inline-block;margin-left:6px;color:var(--muted);font-size:9px}.pill{font-size:9px;font-weight:800;padding:3px 6px;border-radius:10px;background:#e9f3ef;color:var(--green2);white-space:nowrap}.pill.negative{background:#f8e9e7;color:#ad4a45}.pill.warn{background:#faefdf;color:#a56b24}
.stat-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:13px}.mini{background:#fff;border:1px solid var(--line);border-radius:13px;padding:12px;box-shadow:0 5px 18px rgba(30,43,37,.04)}.mini span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.mini strong{display:block;font-size:19px;margin-top:3px}.mini em{font-style:normal;font-size:9px;color:var(--muted)}
.splitbar{height:10px;border-radius:20px;display:flex;overflow:hidden;background:#eee;margin-bottom:12px}.splitbar i:first-child{background:var(--gold)}.splitbar i:last-child{background:var(--green)}.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:10px;color:var(--muted);margin-top:8px}.swatch{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px}.swatch.gold{background:var(--gold)}.swatch.green{background:var(--green)}
.funnel{display:grid;gap:10px}.funnel-row{display:grid;grid-template-columns:120px 1fr 75px;gap:10px;align-items:center}.funnel-row label{font-size:11px;font-weight:700}.funnel-row label small{display:block;color:var(--muted);font-weight:500}.funnel-bar{height:20px;background:#f0ede7;border-radius:5px;overflow:hidden}.funnel-bar.blocked{background:repeating-linear-gradient(45deg,#f0ede7 0 5px,#fff 5px 10px)}.funnel-bar.aside i{background:var(--gold)}.funnel-bar i{display:block;height:100%;width:var(--w);background:linear-gradient(90deg,var(--green),var(--green2));border-radius:5px}.funnel-val{text-align:right;font-size:11px}.funnel-val b{display:block}.funnel-val small{color:var(--muted)}
.marketing-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.ms{padding:10px;background:var(--soft);border-radius:10px}.ms span{font-size:9px;color:var(--muted)}.ms strong{display:block;margin-top:2px;font-size:16px;color:var(--muted)}
.hbar-row{display:grid;grid-template-columns:110px 1fr 38px;gap:8px;align-items:center;margin:9px 0;font-size:10px}.hbar-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hbar-row .bar{height:9px}.hbar-row b{text-align:right}
.ops-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:13px}.op-card{padding:13px}.op-card span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.05em}.op-card strong{display:block;font-size:20px;margin:4px 0 2px}
.footer-note{font-size:9px;color:var(--muted);margin-top:11px;padding-top:9px;border-top:1px solid var(--line)}.foot{font-size:10px;color:var(--muted);margin-top:18px}
@media(max-width:1080px){.kpis{grid-template-columns:repeat(4,1fr)}.grid3{grid-template-columns:1fr 1fr}.grid3>*:last-child{grid-column:1/-1}.ops-cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:1080px){.grid-wide{grid-template-columns:1fr}}
@media(max-width:760px){.shell{padding:15px}.topbar{align-items:flex-start;flex-direction:column}.controls{justify-content:flex-start}.kpis{grid-template-columns:repeat(2,1fr)}.grid2,.grid2.equal,.grid3{grid-template-columns:1fr}.grid3>*:last-child{grid-column:auto}.stat-strip{grid-template-columns:repeat(2,1fr)}.chart{height:205px}.notice{align-items:flex-start;flex-direction:column}.marketing-summary{grid-template-columns:1fr 1fr}.funnel-row{grid-template-columns:90px 1fr 60px}.panel{padding:15px}}
@media print{body{background:#fff}.shell{max-width:none;padding:0}.controls,.report-nav,.metric-tabs{display:none!important}.view{display:block!important;break-before:page}.view:first-of-type{break-before:auto}.card{box-shadow:none;break-inside:avoid}.chart{display:block!important;height:200px}}`;

// Tabs, the trend metric and the comparison switch. Everything it toggles is
// already rendered, so a reader with scripts off loses nothing but the tabs.
const SCRIPT = `document.body.classList.add('js');
const q=(s)=>[...document.querySelectorAll(s)];
q('#reportNav button').forEach(b=>b.onclick=()=>{q('#reportNav button').forEach(x=>x.classList.toggle('active',x===b));q('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+b.dataset.view));});
q('[data-tabs]').forEach(g=>{const panes=q('[data-pane="'+g.dataset.tabs+'"]');const show=id=>{panes.forEach(p=>p.style.display=p.id===id?'':'none');g.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x.dataset.show===id));};g.querySelectorAll('button').forEach(b=>b.onclick=()=>show(b.dataset.show));show(g.querySelector('button.active').dataset.show);});
q('#compareControls button').forEach(b=>b.onclick=()=>{q('#compareControls button').forEach(x=>x.classList.toggle('active',x===b));document.body.dataset.compare=b.dataset.mode;document.getElementById('comparisonLabel').textContent=b.dataset.label;});`;

/**
 * @param {SalesReportData} data
 * @returns {string}
 */
export function renderSalesReport(data) {
  const generated = new Date(data.generatedAt);
  const stamp = Number.isNaN(generated.getTime())
    ? ''
    : generated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: data.timezone || 'UTC' });
  const momLabel = `vs ${data.compare.mom}`;
  const yoyLabel = `vs ${data.compare.yoy}`;
  // 6M changes the figures as well as the chip, so its label names the window.
  const sixLabel = `${data.compare.sixLabel ?? '6 months'} vs ${data.compare.six ?? 'the six before'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Qiriness — Sales report, ${escapeHtml(data.label)}</title>
<style>${STYLE}</style>
</head>
<body data-compare="mom">
<main class="shell">
  <header class="topbar">
    <div><div class="eyebrow">Qiriness · E-commerce</div><h1>Sales Performance</h1><div class="subtitle">${escapeHtml(data.label)}${data.inProgress ? ' (in progress)' : ''} · monthly management report</div></div>
    <div class="controls">
      <div class="segmented" id="compareControls"><button class="active" data-mode="mom" data-label="${escapeHtml(momLabel)}">MoM</button><button data-mode="yoy" data-label="${escapeHtml(yoyLabel)}">YoY</button><button data-mode="six" data-label="${escapeHtml(sixLabel)}">6M vs 6M</button></div>
      <span class="stamp">Generated ${escapeHtml(stamp)}</span>
    </div>
  </header>
  <div class="notice"><span><span class="dot"></span><b>Live data</b> from Shopify: all platforms, net revenue after refunds, cancelled orders excluded. A dash means the figure has no source yet — never zero.</span><span id="comparisonLabel">${escapeHtml(momLabel)}</span></div>
  <nav class="report-nav" id="reportNav"><button class="active" data-view="overview">Overview</button><button data-view="customers">Customers &amp; Products</button><button data-view="marketing">Marketing &amp; Funnel</button><button data-view="operations">Operations</button></nav>
${overview(data)}
${customersAndProducts(data)}
${marketing(data)}
${operations(data)}
  <p class="foot">Qiriness Support OS · ${escapeHtml(data.label)} in the shop's timezone (${escapeHtml(data.timezone)}). Profitability is not reported: cost of goods, shipping cost and ad spend do not reach this app.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** The download's file name. */
export function reportFileName(month) {
  return `qiriness-sales-report-${String(month).replace(/[^0-9-]/g, '')}.html`;
}
