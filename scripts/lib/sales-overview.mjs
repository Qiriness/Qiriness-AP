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

const STATUS_LIMITS = Object.freeze([
  { status: 'critical', maxDays: 7 },
  { status: 'low', maxDays: 14 },
  { status: 'watch', maxDays: INVENTORY_MAX_COVER_DAYS }
]);

export const INVENTORY_STATUS_LABELS = Object.freeze({
  out: 'Out of stock',
  critical: 'Critical',
  low: 'Low',
  watch: 'Watch'
});

/**
 * One product's standing. Nothing on the shelf is `out` whatever the rate —
 * including a product nobody bought in the window, which has no cover to
 * compute and is still unsellable. Null when it is not an exception at all.
 */
export function inventoryStatus(stock, coverDays) {
  if (stock === null || stock === undefined || !Number.isFinite(Number(stock))) return null;
  if (Number(stock) <= 0) return 'out';
  if (coverDays === null || coverDays === undefined || !Number.isFinite(Number(coverDays))) return null;
  const limit = STATUS_LIMITS.find((l) => Number(coverDays) <= l.maxDays);
  return limit ? limit.status : null;
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
        title: `${out} product${out === 1 ? '' : 's'} out of stock${critical ? `, ${critical} under a week of cover` : ''}`,
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
