/**
 * The judgements behind the Overview panel and the monthly sales report: which
 * stock is at risk, what moved revenue, and which exceptions deserve a line.
 *
 * PURE AND ISOMORPHIC. The panel service and the report service both call it,
 * so the dashboard and the email the CEOs read cannot disagree about what
 * "low stock" means or which signal leads. SQL returns measurements
 * (insights_inventory_exceptions, insights_sales_overview); the words and the
 * thresholds are here, where a test can hold them.
 */

// --- stock ------------------------------------------------------------------

/** Units leaving over this many days set the rate a product's cover is read at. */
export const INVENTORY_WINDOW_DAYS = 30;

/**
 * Cover, in days at that rate, below which a product is listed. Past it a
 * product is fine for a month and is not an exception.
 */
export const INVENTORY_MAX_COVER_DAYS = 30;

/**
 * Units below which an active product is listed whatever its cover: a slow
 * seller with a handful left is one order from out, and its long cover hides it.
 */
export const INVENTORY_MIN_STOCK_UNITS = 50;

/**
 * CRITICAL: under two weeks of cover, OR under this many units whatever the
 * cover (owner, 2026-10-27). It replaced « critical ≤ 7 days, low ≤ 14 days »:
 * the stock alert mails on a product newly critical, so the word needed one
 * meaning, and a slow seller with a few dozen units left is one order from out.
 */
export const INVENTORY_CRITICAL_COVER_DAYS = 14;
export const INVENTORY_CRITICAL_UNITS = 40;

export const INVENTORY_STATUS_LABELS = Object.freeze({
  out: 'Out of stock',
  critical: 'Critical',
  watch: 'Watch'
});

/**
 * One product's standing. Nothing on the shelf is `out` whatever the rate —
 * including a product nobody bought in the window, which has no cover to
 * compute and is still unsellable. `critical`: under
 * INVENTORY_CRITICAL_COVER_DAYS of cover, or under INVENTORY_CRITICAL_UNITS.
 * `watch`: up to INVENTORY_MAX_COVER_DAYS of cover, or under
 * INVENTORY_MIN_STOCK_UNITS. Null when it is not an exception.
 */
export function inventoryStatus(stock, coverDays) {
  if (stock === null || stock === undefined || !Number.isFinite(Number(stock))) return null;
  const units = Number(stock);
  if (units <= 0) return 'out';
  const cover = coverDays !== null && coverDays !== undefined && Number.isFinite(Number(coverDays)) ? Number(coverDays) : null;
  if ((cover !== null && cover < INVENTORY_CRITICAL_COVER_DAYS) || units < INVENTORY_CRITICAL_UNITS) return 'critical';
  if ((cover !== null && cover <= INVENTORY_MAX_COVER_DAYS) || units < INVENTORY_MIN_STOCK_UNITS) return 'watch';
  return null;
}

/** Out of stock or critical: what the stock alert lists (scripts/lib/stock-alert.mjs). */
export function isAlertStatus(status) {
  return status === 'out' || status === 'critical';
}

/**
 * Units below which a product still on the shelf is ranked straight after the
 * out-of-stock ones, whatever its cover (owner, 2026-10-27: 20, then 40 the
 * same day, the critical floor). A cover worked out from a slow month can look
 * comfortable while there are a dozen units left.
 */
export const INVENTORY_VERY_LOW_UNITS = INVENTORY_CRITICAL_UNITS;

/**
 * The order of risk, every list of stock exceptions in it (owner, 2026-10-27):
 *   1. out of stock, best sellers of the window first;
 *   2. under INVENTORY_VERY_LOW_UNITS units, lowest cover first;
 *   3. the rest, lowest cover first.
 * Within a group, a product with no cover (nothing left in the window) goes
 * after those with one; ties go to fewer units, then more sold, then the name.
 * Returns a new array. `items`: `{ stock, coverDays, unitsOut, title }`.
 */
export function rankInventoryByRisk(items) {
  const group = (item) => (item.stock <= 0 ? 0 : item.stock < INVENTORY_VERY_LOW_UNITS ? 1 : 2);
  const cover = (item) => (item.coverDays === null || item.coverDays === undefined ? Infinity : Number(item.coverDays));
  return [...items].sort(
    (a, b) =>
      group(a) - group(b) ||
      (group(a) === 0 ? 0 : cover(a) - cover(b)) ||
      a.stock - b.stock ||
      b.unitsOut - a.unitsOut ||
      String(a.title).localeCompare(String(b.title))
  );
}

// --- revenue ------------------------------------------------------------------

/** Relative change, or null where no honest percentage exists. */
function rel(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Average order value: net revenue over paid orders, or null with no order. */
export function averageOrderValue(revenue, paidOrders) {
  return paidOrders > 0 ? revenue / paidOrders : null;
}

/**
 * Gross sales down to net revenue, reconciling exactly:
 *
 *   gross    = what was charged + what was given away (grossRevenue + discounts)
 *   discounts  Shopify's total_discounts: gifts, free shipping, codes
 *   refunds  = charged minus kept (grossRevenue - revenue), uncancelled orders
 *   net      = revenue
 *
 * `grossRevenue` and `revenue` are insights_orders_summary's, so the net here
 * is the revenue every other card prints.
 */
export function revenueBridge({ grossRevenue, revenue, discounts }) {
  const refunds = Math.max(0, grossRevenue - revenue);
  return {
    gross: grossRevenue + discounts,
    discounts,
    refunds,
    net: revenue
  };
}

/**
 * What moved revenue: revenue = orders x AOV, each as a relative change. The
 * two do not add up to the total — the interaction term stays in it — which is
 * why the total is shown beside them rather than as their sum. Sessions and
 * conversion belong in the same line and have no source yet; the caller draws
 * them blocked.
 */
export function revenueDrivers(current, previous) {
  if (!previous) return { total: null, orders: null, aov: null, lead: null };
  const total = rel(current.revenue, previous.revenue);
  const orders = rel(current.paidOrders, previous.paidOrders);
  // Shopify's own AOV when the caller has it, so the driver moves with the AOV
  // card rather than with revenue ÷ orders, which is a different figure.
  const aov =
    current.aov !== undefined && previous.aov !== undefined
      ? rel(current.aov, previous.aov)
      : rel(averageOrderValue(current.revenue, current.paidOrders), averageOrderValue(previous.revenue, previous.paidOrders));
  const candidates = [
    ['orders', orders],
    ['aov', aov]
  ].filter(([, v]) => v !== null);
  const lead = candidates.length
    ? candidates.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))[0]
    : null;
  return { total, orders, aov, lead };
}

// --- signals ------------------------------------------------------------------

const pct = (fraction) => `${(Math.abs(fraction) * 100).toFixed(1)}%`;
const pts = (diff) => `${Math.abs(diff).toFixed(1)} pts`;

/** Late dispatch past this share of shipped orders is a warning — the Fulfilment tile's line. */
export const LATE_DISPATCH_WARN = 10;

/**
 * The management signals: rule-based exceptions, never a model's opinion.
 * At most four, in a fixed order — revenue, discounting, stock, dispatch — so
 * the same month always reads the same way. A rule with nothing to compare
 * against says so rather than inventing a direction.
 *
 * @param {{
 *   compareLabel: string,
 *   current: { revenue: number, paidOrders: number, aov?: number | null, grossRevenue: number, discounts: number, measured: number, over72h: number },
 *   previous: null | { revenue: number, paidOrders: number, aov?: number | null, grossRevenue: number, discounts: number, measured: number, over72h: number },
 *   inventory: { status: string }[] | null,
 *   revenueLabel?: string,
 * }} input
 * @returns {{ tone: 'good' | 'warn' | 'neutral', title: string, detail: string }[]}
 */
export function managementSignals({ compareLabel, current, previous, inventory, revenueLabel = 'Revenue' }) {
  const signals = [];
  const drivers = revenueDrivers(current, previous);

  if (drivers.total === null) {
    signals.push({
      tone: 'neutral',
      title: `No earlier period to compare ${revenueLabel.toLowerCase()} with`,
      detail: `${current.paidOrders.toLocaleString('en-GB')} orders in the period.`
    });
  } else {
    const up = drivers.total >= 0;
    const lead =
      drivers.lead === 'orders'
        ? `Order volume moved most (${drivers.orders >= 0 ? '+' : '−'}${pct(drivers.orders)}).`
        : drivers.lead === 'aov'
          ? `Average order value moved most (${drivers.aov >= 0 ? '+' : '−'}${pct(drivers.aov)}).`
          : '';
    signals.push({
      tone: up ? 'good' : 'warn',
      title: `${revenueLabel} ${up ? 'grew' : 'fell'} ${pct(drivers.total)} vs ${compareLabel}`,
      detail: lead
    });
  }

  const share = (s) => {
    const gross = s.grossRevenue + s.discounts;
    return gross > 0 ? (s.discounts / gross) * 100 : null;
  };
  const discountNow = share(current);
  const discountBefore = previous ? share(previous) : null;
  if (discountNow !== null) {
    if (discountBefore === null) {
      signals.push({
        tone: 'neutral',
        title: `Discounts & gifts were ${discountNow.toFixed(1)}% of gross sales`,
        detail: 'No earlier period to compare with.'
      });
    } else {
      const diff = discountNow - discountBefore;
      const flat = Math.abs(diff) < 0.05;
      signals.push({
        tone: flat ? 'neutral' : diff > 0 ? 'warn' : 'good',
        title: flat
          ? `Discount rate unchanged at ${discountNow.toFixed(1)}%`
          : `Discount rate ${diff > 0 ? 'rose' : 'fell'} ${pts(diff)} to ${discountNow.toFixed(1)}%`,
        detail: diff > 0 ? 'More of gross sales was given away — check what the promotions brought in.' : 'More revenue was kept per gross euro.'
      });
    }
  }

  if (inventory) {
    const out = inventory.filter((i) => i.status === 'out').length;
    const critical = inventory.filter((i) => i.status === 'critical').length;
    if (out + critical > 0) {
      signals.push({
        tone: 'warn',
        title: `${out} product${out === 1 ? '' : 's'} out of stock${critical ? `, ${critical} critical (under two weeks of cover or 40 units)` : ''}`,
        detail: 'Active products, as of the last product sync.'
      });
    } else {
      signals.push({ tone: 'good', title: 'No active product is out of stock', detail: 'As of the last product sync.' });
    }
  }

  if (current.measured > 0) {
    const late = (current.over72h / current.measured) * 100;
    signals.push({
      tone: late > LATE_DISPATCH_WARN ? 'warn' : 'good',
      title: `${late.toFixed(1)}% of orders shipped after 3 days`,
      detail: `${current.over72h.toLocaleString('en-GB')} of ${current.measured.toLocaleString('en-GB')} shipped orders.`
    });
  }

  return signals.slice(0, 4);
}
