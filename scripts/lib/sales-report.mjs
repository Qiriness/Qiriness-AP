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
 *   modes: { mom: ReportMode, yoy: ReportMode, six: ReportMode },
 *   trend: { key: string, label: string, revenue: number | null, orders: number | null }[],
 *   platforms: { label: string, revenue: number, orders: number }[],
 *   promotions: { name: string | null, kind: string | null, target: string | null, orders: number, revenue: number, discount: number, newCustomerOrders: number | null }[],
 *   funnel: { key: string, label: string, value: number | null, ofEntry: number | null, ofPrevious: number | null }[],
 *   channels: { channel: string, sessions: number | null, revenue: number | null, orders: number | null, conversionRate: number | null, revenuePerSession: number | null }[],
 *   channelsBlockedReason: string | null,
 *   inventory: { items: { title: string, stock: number, unitsOut: number, coverDays: number | null, status: string }[], windowDays: number, syncedAt: string | null },
 *   carriers: { carrier: string, shipments: number, p50Hours: number | null, over72h: number }[],
 *   signals: { tone: string, title: string, detail: string }[]
 * }} SalesReportData
 *
 * @typedef {{
 *   label: string, currentLabel: string, comparisonLabel: string, offset: number,
 *   period: ReportPeriod | null, comparison: ReportPeriod | null,
 *   products: null | { comparable: boolean, revenue: ReportProduct[], growth: ReportProduct[], decline: ReportProduct[], productRevenue: number },
 *   collections: null | { collectionId: string | null, title: string, products: number, orders: number, revenue: number, previousRevenue: number | null }[]
 * }} ReportMode
 *
 * @typedef {{ title: string, revenue: number, orders: number, units: number, previousRevenue: number | null }} ReportProduct
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
 * The change between two figures of the same kind, as a chip.
 *
 * EVERY SECTION IS RENDERED ONCE PER COMPARISON (see `perMode`), so nothing
 * here needs to know which switch is showing — it is handed the period and the
 * period it is compared with. A missing comparison says "no comparison" rather
 * than printing a dash that could be read as zero.
 */
function chip(current, previous, options = {}) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return deltaChip(null, options);
  }
  const value = options.points || options.absolute ? current - previous : rel(current, previous);
  return deltaChip(value, options);
}

/** The three comparisons, in the order the switch offers them. */
const MODES = ['mom', 'yoy', 'six'];

/**
 * One block per comparison, each wrapped so CSS can show the selected one.
 *
 * The whole block is repeated rather than just its chips, because the
 * six-month view reports a different PERIOD — a half-year's figures, not the
 * month's — and a card showing the month's revenue above a half-year's change
 * would be the most confident wrong thing on the page.
 */
function perMode(data, render) {
  return MODES.map((key) => `<div data-cmp="${key}">${render(data.modes[key], data)}</div>`).join('');
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

function kpis(mode) {
  const c = mode.period;
  const p = mode.comparison;
  if (!c) {
    return `<div class="notice"><span><b>No ${escapeHtml(mode.label)} figures:</b> the order history does not reach ${escapeHtml(mode.currentLabel)}.</span></div>`;
  }
  const cards = [
    kpiCard('Total sales', money(totalOf(c)), chip(totalOf(c), totalOf(p))),
    kpiCard(
      'Net sales',
      money(c.netSales),
      chip(c.netSales, p?.netSales),
      c.netSales === null ? 'Shopify Analytics could not be read' : undefined
    ),
    kpiCard('Orders', num(c.paidOrders), chip(c.paidOrders, p?.paidOrders)),
    kpiCard('Units sold', num(c.units), chip(c.units, p?.units)),
    kpiCard('AOV', money(aovOf(c), true), chip(aovOf(c), aovOf(p))),
    kpiCard('Refund rate', pct(refundRateOf(c)), chip(refundRateOf(c), refundRateOf(p), { points: true, polarity: 'down' })),
    kpiCard(
      'Sessions',
      num(c.sessions),
      chip(c.sessions, p?.sessions),
      c.sessions === null ? 'Shopify Analytics could not be read' : undefined
    ),
    kpiCard(
      'Conversion',
      pct(c.conversionRate, 2),
      chip(c.conversionRate, p?.conversionRate, { points: true }),
      c.conversionRate === null ? 'Shopify Analytics could not be read' : undefined
    )
  ];
  return `<div class="kpis">${cards.join('')}</div>`;
}

/**
 * The trend, drawn as inline SVG so it survives any mail client that shows
 * images: the last `drawn` months solid, and the same months one comparison
 * earlier UNDER THEM AS A DOTTED LINE.
 *
 * `offset` is how far back that line sits — one month for MoM, twelve for both
 * year-on-year views — which is why the data carries two years of buckets for a
 * twelve-month chart. Both series share one scale, or the comparison would look
 * level with a year that dwarfs it.
 */
function trendSvg(months, metric, { drawn = 12, offset = 0, comparisonLabel = '' } = {}) {
  const w = 700;
  const h = 215;
  const p = { l: 52, r: 14, t: 12, b: 28 };
  const points = months.slice(-drawn);
  const start = months.length - drawn - offset;
  const compare = offset > 0 && start >= 0 ? months.slice(start, start + drawn) : [];
  const valuesOf = (rows) => rows.map((x) => x[metric]);
  const values = valuesOf(points);
  const compareValues = valuesOf(compare);
  const measured = [...values, ...compareValues].filter((v) => v !== null && Number.isFinite(v));
  if (measured.length === 0) return '<p class="muted">No orders in these months.</p>';
  const hi = Math.max(...measured) * 1.06 || 1;
  const x = (i) => p.l + (i * (w - p.l - p.r)) / Math.max(1, points.length - 1);
  const y = (v) => p.t + ((hi - v) * (h - p.t - p.b)) / hi;
  let grid = '';
  for (let i = 0; i < 4; i += 1) {
    const yy = p.t + (i * (h - p.t - p.b)) / 3;
    const v = hi - (i * hi) / 3;
    // The bottom gridline lands on a rounding error, not on zero, and printed
    // as "-0k" in a month with no orders.
    const rounded = metric === 'revenue' ? Math.round(v / 1000) : Math.round(v);
    const label = metric === 'revenue' ? `€${GROUPED.format(rounded === 0 ? 0 : rounded)}k` : GROUPED.format(rounded === 0 ? 0 : rounded);
    grid += `<line class="axis" x1="${p.l}" y1="${yy.toFixed(1)}" x2="${w - p.r}" y2="${yy.toFixed(1)}"/><text class="axis-label" x="${p.l - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${label}</text>`;
  }
  // A month with no data breaks the line rather than dropping it to zero.
  const polyline = (vals, cls) => {
    const segments = [];
    let run = [];
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        if (run.length) segments.push(run);
        run = [];
      } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (run.length) segments.push(run);
    return segments.map((seg) => `<polyline class="${cls}" points="${seg.join(' ')}"/>`).join('');
  };
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
  const legend = compare.length
    ? `<div class="legend"><span><i class="dash solid"></i>${escapeHtml(points[0].label)} – ${escapeHtml(points[points.length - 1].label)}</span><span><i class="dash dotted"></i>${escapeHtml(compare[0].label)} – ${escapeHtml(compare[compare.length - 1].label)}${comparisonLabel ? ` (${escapeHtml(comparisonLabel)})` : ''}</span></div>`
    : '<div class="legend"><span>No earlier period to lay underneath.</span></div>';
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${metric === 'revenue' ? 'Revenue' : 'Orders'} over ${points.length} months, with the comparison period">${grid}${polyline(compareValues, 'line compare')}${polyline(values, 'line')}${dots}${labels}</svg>${legend}`;
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
  // THE SAME TOP LINE AS THE KPI ABOVE IT. The decomposition splits whatever
  // the report calls total sales, so it reads Shopify's figure wherever Shopify
  // answered — otherwise this card reported a different change from the card
  // beside it, off by the shipping and VAT that our order records carry.
  //
  // `other` carries the storefront figures too, so the traffic rows compare
  // against the same period as the money rows.
  const d = revenueDrivers(
    { revenue: totalOf(current), paidOrders: current.paidOrders },
    other ? { revenue: totalOf(other), paidOrders: other.paidOrders } : null
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

/** Where one comparison's revenue came from. A window nobody measured says so. */
function salesMix(mode) {
  const rows = mode.platforms;
  if (!rows || rows.length === 0) {
    return `<p class="muted">No comparison: ${escapeHtml(mode.currentLabel)} is outside the synced order history.</p>`;
  }
  const total = rows.reduce((sum, x) => sum + x.revenue, 0);
  return hbars(rows.map((x) => ({ label: x.label, value: x.revenue })), total);
}

function overview(data) {
  return `<section class="view active" id="view-overview">
${perMode(data, (mode) => kpis(mode))}
<div class="grid2">
  <article class="card panel"><div class="panel-head"><div><h2>Performance trend</h2><div class="hint">${data.trendMonths ?? 12} months ending ${escapeHtml(data.label)}, with the compared period dotted</div></div><div class="metric-tabs" data-tabs="trend"><button class="active" data-show="trend-revenue">Revenue</button><button data-show="trend-orders">Orders</button></div></div>
    <div data-pane="trend" id="trend-revenue">${perMode(data, (mode) =>
      `<div class="chart">${trendSvg(data.trend, 'revenue', { drawn: data.trendMonths ?? 12, offset: mode.offset, comparisonLabel: mode.label })}</div>`
    )}</div>
    <div data-pane="trend" id="trend-orders">${perMode(data, (mode) =>
      `<div class="chart">${trendSvg(data.trend, 'orders', { drawn: data.trendMonths ?? 12, offset: mode.offset, comparisonLabel: mode.label })}</div>`
    )}</div>
  </article>
  <article class="card panel"><div class="panel-head"><div><h2>What moved revenue?</h2><div class="hint">Total sales = orders × basket</div></div></div>
${perMode(data, (mode) =>
  mode.period
    ? driversFor(mode.period, mode.comparison, mode.comparisonLabel)
    : '<p class="muted">Not enough order history for this comparison.</p>'
)}
  </article>
</div>
<div class="grid3">
  <article class="card panel"><div class="panel-head"><div><h2>Sales bridge</h2><div class="hint">Shopify's own figures, top line to bottom line</div></div></div>${perMode(data, (mode) =>
    mode.period ? bridge(mode.period) : '<p class="muted">Not enough order history for this comparison.</p>'
  )}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Management signals</h2><div class="hint">Rule-based exceptions, not AI · always ${escapeHtml(data.label)} against ${escapeHtml(data.modes.mom.comparisonLabel)}, whichever comparison is selected</div></div></div>${signals(data.signals)}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Sales mix</h2><div class="hint">Where the revenue came from</div></div></div>${perMode(data, (mode) => salesMix(mode))}</article>
</div>
</section>`;
}

function newsletterCard(mode, data) {
  const c = mode.period;
  if (!c || !c.newsletter) {
    return `<article class="card panel"><div class="panel-head"><div><h2>Newsletter subscribers</h2><div class="hint">Gained and lost</div></div></div><p class="muted">Not measurable for this period: Shopify's consent record holds no unsubscribe this early, so losses would read as zero.</p></article>`;
  }
  const n = c.newsletter;
  const before = mode.comparison?.newsletter ?? null;
  const net = n.subscribed - n.unsubscribed;
  const total = n.subscribed + n.unsubscribed;
  // Gained and lost compare as percentages; net can be negative, so a
  // percentage of it reads backwards and it compares in people instead.
  const row = (label, value, current, previous, polarity, absolute = false) =>
    `<tr><td><b>${label}</b></td><td>${value}</td><td>${chip(current, previous, { polarity, absolute })}</td></tr>`;
  return `<article class="card panel"><div class="panel-head"><div><h2>Newsletter subscribers</h2><div class="hint">Gained and lost in ${escapeHtml(mode.currentLabel)} · Shopify customers</div></div><span class="pill ${net >= 0 ? '' : 'negative'}">Net ${net >= 0 ? '+' : '−'}${num(Math.abs(net))}</span></div>
<div class="splitbar"><i style="width:${total > 0 ? ((n.subscribed / total) * 100).toFixed(1) : 50}%;background:var(--green2)"></i><i style="width:${total > 0 ? ((n.unsubscribed / total) * 100).toFixed(1) : 50}%;background:var(--rose)"></i></div>
<table><thead><tr><th></th><th>${escapeHtml(mode.currentLabel)}</th><th>vs ${escapeHtml(mode.comparisonLabel)}</th></tr></thead><tbody>
${row('Gained', `+${num(n.subscribed)}`, n.subscribed, before?.subscribed, 'up')}
${row('Lost', `−${num(n.unsubscribed)}`, n.unsubscribed, before?.unsubscribed, 'down')}
${row('Net', `${net >= 0 ? '+' : '−'}${num(Math.abs(net))}`, net, before ? before.subscribed - before.unsubscribed : null, 'up', true)}
</tbody></table>
<div class="footer-note">${num(n.subscribersNow)} on the list at generation. Read from each customer's current consent and when it last changed, so both figures are floors: someone who joined and left inside the period counts once, as a loss.</div></article>`;
}

function customersAndProducts(data) {
  return `<section class="view" id="view-customers">
${perMode(data, (mode) => customerBlock(mode, data))}
</section>`;
}

/** The customer strip, the mix, the newsletter and the product tables, for one comparison. */
function customerBlock(mode, data) {
  const c = mode.period;
  if (!c) {
    return `<div class="notice"><span><b>No figures for ${escapeHtml(mode.currentLabel)}:</b> the order history does not reach it.</span></div>`;
  }
  const mix = c.customers;
  const before = mode.comparison?.customers ?? null;
  const orders = mix ? mix.newCustomerOrders + mix.returningCustomerOrders : 0;
  const people = mix ? mix.newCustomers + mix.returningCustomers : 0;
  const mixHtml = mix
    ? `<div class="splitbar"><i style="width:${(share(mix.newCustomerOrders, orders) ?? 50).toFixed(1)}%"></i><i style="width:${(100 - (share(mix.newCustomerOrders, orders) ?? 50)).toFixed(1)}%"></i></div>
<table><thead><tr><th>Segment</th><th>Customers</th><th>Orders</th><th>Share of orders</th><th>vs ${escapeHtml(mode.comparisonLabel)}</th></tr></thead><tbody>
<tr><td><b>New</b></td><td>${num(mix.newCustomers)}</td><td>${num(mix.newCustomerOrders)}</td><td>${pct(share(mix.newCustomerOrders, orders), 0)}</td><td>${chip(mix.newCustomers, before?.newCustomers)}</td></tr>
<tr><td><b>Returning</b></td><td>${num(mix.returningCustomers)}</td><td>${num(mix.returningCustomerOrders)}</td><td>${pct(share(mix.returningCustomerOrders, orders), 0)}</td><td>${chip(mix.returningCustomers, before?.returningCustomers)}</td></tr>
</tbody></table><div class="legend"><span><i class="swatch gold"></i>New</span><span><i class="swatch green"></i>Returning</span><span>${num(people)} Shopify customers ordered</span></div>`
    : '<p class="muted">No Shopify customer ordered in this period.</p>';

  const repeatShare = mix ? share(mix.returningCustomerOrders, orders) : null;
  const beforeRepeat = before ? share(before.returningCustomerOrders, before.newCustomerOrders + before.returningCustomerOrders) : null;
  const perCustomer = mix && people > 0 ? orders / people : null;
  const beforePerCustomer =
    before && before.newCustomers + before.returningCustomers > 0
      ? (before.newCustomerOrders + before.returningCustomerOrders) / (before.newCustomers + before.returningCustomers)
      : null;
  const strip = mix
    ? [
        ['New customers', num(mix.newCustomers), chip(mix.newCustomers, before?.newCustomers)],
        ['Returning customers', num(mix.returningCustomers), chip(mix.returningCustomers, before?.returningCustomers)],
        ['Returning share of orders', pct(repeatShare), chip(repeatShare, beforeRepeat, { points: true })],
        ['Orders per customer', perCustomer === null ? '—' : `${perCustomer.toFixed(2)}×`, chip(perCustomer, beforePerCustomer)]
      ]
    : [];

  return `${strip.length ? `<div class="stat-strip">${strip
    .map(([label, value, delta]) => `<div class="mini"><span>${label}</span><strong>${value}</strong><em>${delta} vs ${escapeHtml(mode.comparisonLabel)}</em></div>`)
    .join('')}</div>` : ''}
<div class="grid2 equal">
  <article class="card panel"><div class="panel-head"><div><h2>New vs returning customers</h2><div class="hint">Shopify customers; marketplaces create a customer per order and are left out</div></div></div>${mixHtml}</article>
  ${newsletterCard(mode, data)}
</div>
<div class="grid-wide">
${productCard(mode)}
${collectionMix(mode)}
</div>`;
}

/**
 * The product tables for one comparison: the largest, the biggest gains and the
 * biggest falls, switched by the tabs above them.
 *
 * GROWTH AND DECLINES ARE RANKED IN EUROS, not per cent: a product that went
 * from 4 to 40 euros is not the period's story. Without a comparable period
 * both tables say so rather than showing an arbitrary ten rows.
 */
function productCard(mode) {
  const tables = mode.products;
  const id = (name) => `products-${mode.label.replace(/[^a-z0-9]+/gi, '').toLowerCase()}-${name}`;
  if (!tables || tables.revenue.length === 0) {
    return `<article class="card panel"><div class="panel-head"><div><h2>Product performance</h2><div class="hint">Top products by net line revenue</div></div></div><p class="muted">No product sold in this period.</p></article>`;
  }
  const rows = (list, empty) =>
    list.length === 0
      ? `<p class="muted">${empty}</p>`
      : `<table><thead><tr><th>Product</th><th>Revenue</th><th>Δ €</th><th>Δ %</th><th>Orders</th><th>Units</th></tr></thead><tbody>${list
          .map((product, i) => {
            const diff = product.previousRevenue === null ? null : product.revenue - product.previousRevenue;
            const change = rel(product.revenue, product.previousRevenue);
            return `<tr><td><span class="rank">${i + 1}</span><b>${escapeHtml(product.title)}</b></td><td>${money(product.revenue)}</td><td class="${diff === null ? 'flat' : diff >= 0 ? 'up' : 'down'}">${diff === null ? '—' : `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}`}</td><td>${change === null ? (product.previousRevenue === null ? '<span class="muted">—</span>' : '<span class="pill">new</span>') : `<span class="pill ${change < 0 ? 'negative' : ''}">${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%</span>`}</td><td>${num(product.orders)}</td><td>${num(product.units)}</td></tr>`;
          })
          .join('')}</tbody></table>`;
  const none = tables.comparable
    ? null
    : `No comparison with ${escapeHtml(mode.comparisonLabel)}: the order history does not reach it.`;
  return `<article class="card panel"><div class="panel-head"><div><h2>Product performance</h2><div class="hint">Top ten by net line revenue, vs ${escapeHtml(mode.comparisonLabel)} · samples and gifts excluded</div></div><div class="metric-tabs" data-tabs="${id('tabs')}"><button class="active" data-show="${id('revenue')}">Revenue</button><button data-show="${id('growth')}">Growth</button><button data-show="${id('decline')}">Declines</button></div></div>
<div data-pane="${id('tabs')}" id="${id('revenue')}">${rows(tables.revenue, 'No product sold in this period.')}</div>
<div data-pane="${id('tabs')}" id="${id('growth')}">${rows(tables.growth, none ?? `No product sold more than it did in ${escapeHtml(mode.comparisonLabel)}.`)}</div>
<div data-pane="${id('tabs')}" id="${id('decline')}">${rows(tables.decline, none ?? `No product sold less than it did in ${escapeHtml(mode.comparisonLabel)}.`)}</div>
</article>`;
}

/**
 * The six ranges the catalogue is managed by, and everything outside them.
 * A product counts in every range that carries it, so the shares overlap and
 * never sum to 100% — the note says so, and nothing here adds them up.
 */
function collectionMix(mode) {
  const rows = mode.collections ?? [];
  if (rows.length === 0) {
    return `<article class="card panel"><div class="panel-head"><div><h2>Collection mix</h2><div class="hint">The ranges the catalogue is managed by</div></div></div><p class="muted">No paid product line in this period.</p></article>`;
  }
  // Share is of ALL paid product revenue in the period. Summing the rows would
  // be wrong twice over: they overlap, and the last row is what they exclude.
  const denominator = mode.products?.productRevenue ?? 0;
  const named = rows.filter((r) => r.collectionId !== null);
  const widest = Math.max(1, ...named.map((r) => r.revenue));
  const line = (r) => {
    const portion = denominator > 0 ? pct((r.revenue / denominator) * 100) : '—';
    const change =
      r.previousRevenue === null
        ? '<span class="muted">no comparison</span>'
        : r.previousRevenue === 0
          ? '<span class="pill">new</span>'
          : chip(r.revenue, r.previousRevenue);
    return `<tr${r.collectionId === null ? ' class="muted"' : ''}><td><b>${escapeHtml(r.title)}</b></td><td>${money(r.revenue)}</td><td>${portion}</td><td>${change}</td></tr>`;
  };
  return `<article class="card panel"><div class="panel-head"><div><h2>Collection mix</h2><div class="hint">The ranges the catalogue is managed by · vs ${escapeHtml(mode.comparisonLabel)}</div></div></div>
<table><thead><tr><th>Collection</th><th>Revenue</th><th>Share</th><th>Δ</th></tr></thead><tbody>${rows.map(line).join('')}</tbody></table>
<div class="concentration">${named.map((r) => `<i style="width:${Math.max(2, (r.revenue / widest) * 100).toFixed(1)}%"></i>`).join('')}</div>
<div class="footer-note">A product counts in every range that carries it, so the shares overlap and never add up to 100%. Share is of the period's paid product revenue; anything in none of the ranges is the last row.</div></article>`;
}

function marketing(data) {
  // The funnel, the channels and the promotions are the MONTH's, whatever the
  // switch says: they are not compared with an earlier period anywhere on this
  // page, and the cards say what they are rather than implying a comparison.
  const c = data.modes.mom.period;
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
    .join('') +
    // The one step Shopify keeps no metric for, kept in the funnel so its
    // absence is visible rather than silently missing.
    '<div class="funnel-row"><label>Product viewers<small>no such metric</small></label><div class="funnel-bar blocked"></div><div class="funnel-val"><b>—</b><small>not measured</small></div></div>';
  const promos = data.promotions
    .map(
      (p) =>
        `<tr><td><b>${escapeHtml(p.name ?? 'No promotion (full price)')}</b>${p.kind === 'code' ? '<span class="sub">code</span>' : ''}</td><td>${money(p.revenue)}</td><td>${num(p.orders)}</td><td>${money(p.orders > 0 ? p.revenue / p.orders : null, true)}</td><td>${p.name === null ? '—' : p.target === 'SHIPPING_LINE' ? 'shipping' : money(p.discount)}</td><td>${p.newCustomerOrders === null ? '—' : num(p.newCustomerOrders)}</td></tr>`
    )
    .join('');
  const fullPriceOrders = c.paidOrders - c.discountedOrders;
  return `<section class="view" id="view-marketing">
<div class="grid2 equal">
  <article class="card panel"><div class="panel-head"><div><h2>E-commerce funnel</h2><div class="hint">Stage conversion and largest leakage · ${escapeHtml(data.label)} only</div></div><span class="pill${c.conversionRate === null ? ' warn' : ''}">CVR ${c.conversionRate === null ? '—' : pct(c.conversionRate, 2)}</span></div>
    <div class="funnel">${funnel}</div>
    <div class="callout"><b>Every step counts sessions, not orders.</b> The last step over the first is Shopify's conversion rate. Our own ${num(c.paidOrders)} paid orders is a larger number because it counts every platform, including marketplace orders that never had a session. <b>Product views are not measurable</b> — Shopify keeps no such metric — so the product row counts sessions that <i>arrived</i> on a product page; it sits outside the chain, and the cart step below is measured against sessions, not against it.</div></article>
  <article class="card panel"><div class="panel-head"><div><h2>Acquisition channels</h2><div class="hint">Shopify's own attribution, both sides on referring_channel · ${escapeHtml(data.label)} only</div></div></div>${channelTable(data)}</article>
</div>
<div class="grid2">
  <article class="card panel"><div class="panel-head"><div><h2>Marketing performance</h2><div class="hint">Owned, paid and organic demand</div></div></div>
    <div class="marketing-summary"><div class="ms"><span>Klaviyo revenue</span><strong>—</strong></div><div class="ms"><span>Ad spend</span><strong>—</strong></div><div class="ms"><span>ROAS</span><strong>—</strong></div><div class="ms"><span>Social reach</span><strong>—</strong></div></div>
    ${blockedTable(['Source', 'Spend', 'Revenue', 'ROAS', 'Conversion'], 'Klaviyo, Google Ads, Meta Ads, Instagram and TikTok are not connected yet.')}</article>
  <article class="card panel"><div class="panel-head"><div><h2>Promotions &amp; discounting</h2><div class="hint">What each promotion recorded on its orders · ${escapeHtml(data.label)} only</div></div></div>
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
  const inv = data.inventory;
  const carrierTotal = data.carriers.reduce((sum, x) => sum + x.shipments, 0);
  const statusClass = (x) => (x === 'out' || x === 'critical' ? 'negative' : x === 'low' ? 'warn' : '');
  const synced = inv.syncedAt ? inv.syncedAt.slice(0, 10) : 'never';
  const opsCards = (mode) => {
    const c = mode.period;
    const p = mode.comparison;
    if (!c) return `<div class="notice"><span><b>No figures for ${escapeHtml(mode.currentLabel)}:</b> the order history does not reach it.</span></div>`;
    const cards = [
      ['Median time to ship', hoursText(c.p50Hours), chip(c.p50Hours, p?.p50Hours, { polarity: 'down' })],
      ['Shipped after 3 days', pct(lateShareOf(c)), chip(lateShareOf(c), lateShareOf(p), { points: true, polarity: 'down' })],
      ['Refunded orders', num(c.refundedOrders), `<span class="delta flat">${money(c.refundedAmount)} refunded</span>`],
      ['Cancelled orders', num(c.cancelledOrders), chip(c.cancelledOrders, p?.cancelledOrders, { polarity: 'down' })]
    ];
    return `<div class="ops-cards">${cards
      .map(([label, value, delta]) => `<article class="card op-card"><span>${label}</span><strong>${value}</strong>${delta}</article>`)
      .join('')}</div>`;
  };
  const c = data.modes.mom.period;

  return `<section class="view" id="view-operations">
${perMode(data, (mode) => opsCards(mode))}
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
.chart{height:225px}.chart+.chart{margin-top:10px}.js .chart+.chart{margin-top:0}.chart svg{width:100%;height:100%;overflow:visible}.axis{stroke:#ebe7df;stroke-width:1}.axis-label{fill:#8a8f8b;font-size:9px}.line{fill:none;stroke:var(--green);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.line.compare{stroke:#9fb3ab;stroke-width:2;stroke-dasharray:5 4}.dash{display:inline-block;width:14px;height:0;border-top:3px solid var(--green);margin-right:5px;vertical-align:middle}.dash.dotted{border-top:2px dashed #9fb3ab}.point{fill:#fff;stroke:var(--green);stroke-width:2}
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
  // Each switch names the window it reports and the window it compares with,
  // because two of the three change the figures and not just the chips.
  const label = (mode) => `${escapeHtml(mode.currentLabel)} vs ${escapeHtml(mode.comparisonLabel)}`;
  const momLabel = label(data.modes.mom);
  const yoyLabel = label(data.modes.yoy);
  const sixLabel = label(data.modes.six);
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
      <div class="segmented" id="compareControls"><button class="active" data-mode="mom" data-label="${momLabel}">MoM</button><button data-mode="yoy" data-label="${yoyLabel}">YoY</button><button data-mode="six" data-label="${sixLabel}">6M on 6M</button></div>
      <span class="stamp">Generated ${escapeHtml(stamp)}</span>
    </div>
  </header>
  <div class="notice"><span><span class="dot"></span><b>Live data</b> from Shopify: all platforms, net revenue after refunds, cancelled orders excluded. A dash means the figure has no source yet — never zero.</span><span id="comparisonLabel">${momLabel}</span></div>
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
