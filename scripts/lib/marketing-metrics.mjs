/**
 * The Marketing Performance figures: one definition each, written once.
 *
 * EVERY FIGURE CARRIES ITS STATE, because « 0 », « not measured » and « not
 * enough data » read the same as a bare number and mean opposite things:
 *
 *   measured        a real figure, zero included
 *   estimated       computed from an assumption the reader can change
 *   unavailable     no source answers it (the reason says which)
 *   insufficient    a source exists but the denominator is empty
 *   not_configured  needs an input nobody has entered yet (costs, margins)
 *   not_tracked     needs tracking this shop does not collect yet
 *
 * DEFINITIONS (shown in each tooltip, in docs/decisions/insights.md):
 *   Provider ROAS      provider-claimed revenue / ad spend
 *   Shopify ROAS       Shopify net sales credited to the paid providers / ad spend
 *   MER                website net sales / ad spend
 *   eMER               website net sales / all measurable marketing costs
 *   New-customer MER   first-order net sales of new customers / ad spend (BLENDED:
 *                      the spend is not split between acquisition and retargeting)
 *   Blended CAC        ad spend / new website customers
 *   CPA                ad spend / orders Shopify credits to the paid providers
 *   Revenue after ads  website net sales - ad spend (NOT profit)
 *
 * « Website » is the shop's own store (the Shopify platform), never a
 * marketplace: an Amazon buyer had no session and saw no ad of ours.
 */

/** @typedef {'measured'|'estimated'|'unavailable'|'insufficient'|'not_configured'|'not_tracked'} FigureState */

export const measured = (value) => ({ value, state: 'measured', reason: null });
export const missing = (state, reason) => ({ value: null, state, reason });

/** a / b, or an `insufficient` figure when b is 0 or either side is missing. */
export function divide(a, b, reason = 'insights.mkt.state.noDenominator') {
  if (a === null || a === undefined || b === null || b === undefined) return missing('unavailable', reason);
  if (!(b > 0)) return missing('insufficient', reason);
  return measured(a / b);
}

/** Change against an earlier value: absolute and per cent (null when the earlier value is 0 or absent). */
export function change(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  return { abs: current - previous, pct: previous !== 0 ? ((current - previous) / Math.abs(previous)) * 100 : null };
}

/**
 * The executive row.
 *
 * @param {object} input
 * @param {number|null} input.websiteNet      own-store net sales (Shopify's ladder)
 * @param {number|null} input.adSpend         paid providers' spend in ONE currency; null if none or mixed
 * @param {string|null} input.adSpendReason   why adSpend is null
 * @param {number|null} input.otherMarketingCosts  configured non-ad costs for the range; null = not configured
 * @param {number|null} input.providerRevenue the paid providers' own claimed revenue, summed (claims overlap)
 * @param {number|null} input.shopifyPaidNet  Shopify net sales credited to the paid providers
 * @param {number|null} input.shopifyPaidOrders orders Shopify credits to the paid providers
 * @param {number|null} input.newCustomers    new website customers in the range
 * @param {number|null} input.newCustomerNet  net sales of new customers' orders
 * @param {number|null} input.returningNet    net sales of returning customers' orders
 */
export function executiveFigures(input) {
  const spend = input.adSpend;
  const noSpend = (key) => missing('unavailable', input.adSpendReason ?? key);
  const bySpend = (numerator) => (spend === null ? noSpend('insights.mkt.state.noSpend') : divide(numerator, spend, 'insights.mkt.state.noSpendInRange'));
  const value = (v, reason) => (v === null || v === undefined ? missing('unavailable', reason) : measured(v));

  const totalCosts =
    spend === null ? noSpend('insights.mkt.state.noSpend') : measured(spend + (input.otherMarketingCosts ?? 0));

  return {
    adSpend: spend === null ? noSpend('insights.mkt.state.noSpend') : measured(spend),
    // Ad spend plus whatever other costs are configured; it equals ad spend until some are.
    marketingCosts: totalCosts,
    websiteNet: value(input.websiteNet, 'insights.mkt.state.noLadder'),
    providerRevenue: spend === null ? noSpend('insights.mkt.state.noSpend') : value(input.providerRevenue, 'insights.mkt.state.noSpend'),
    shopifyPaidNet: value(input.shopifyPaidNet, 'insights.mkt.state.noAttribution'),
    providerRoas: bySpend(input.providerRevenue),
    shopifyRoas: bySpend(input.shopifyPaidNet),
    mer: bySpend(input.websiteNet),
    emer:
      input.otherMarketingCosts === null || input.otherMarketingCosts === undefined
        ? missing('not_configured', 'insights.mkt.state.noCosts')
        : totalCosts.value === null
          ? totalCosts
          : divide(input.websiteNet, totalCosts.value),
    newCustomerMer: bySpend(input.newCustomerNet),
    newCustomers: value(input.newCustomers, 'insights.mkt.state.noAttribution'),
    cac: spend === null ? noSpend('insights.mkt.state.noSpend') : divide(spend, input.newCustomers, 'insights.mkt.state.noNewCustomers'),
    cpa: spend === null ? noSpend('insights.mkt.state.noSpend') : divide(spend, input.shopifyPaidOrders, 'insights.mkt.state.noPaidOrders'),
    newCustomerNet: value(input.newCustomerNet, 'insights.mkt.state.noLadder'),
    returningNet: value(input.returningNet, 'insights.mkt.state.noLadder'),
    revenueAfterAds: spend === null || input.websiteNet === null ? noSpend('insights.mkt.state.noSpend') : measured(input.websiteNet - spend),
    contribution: missing('not_configured', 'insights.mkt.state.noMargins'),
    ltvCac: missing('unavailable', 'insights.mkt.state.noCohorts'),
    ltgpCac: missing('unavailable', 'insights.mkt.state.noCohorts')
  };
}

/**
 * One provider against Shopify.
 *
 * REVENUE IS COMPARED ON THE SAME BASIS: the provider's value against
 * Shopify's TOTAL sales for the same orders (VAT and shipping included), since
 * a pixel records the value the checkout sends rather than Shopify's net
 * sales. Net sales are carried beside it for the ROAS the KPI row prints.
 *
 * @param {object} p
 * @param {{revenue:number, conversions:number}|null} p.provider  null = the provider reports nothing here
 * @param {{netSales:number,totalSales:number,orders:number,newCustomers:number}|undefined} p.shopify  undefined = nothing credited
 * @param {{sessions:number,convertedSessions:number}|null} p.sessions
 * @param {number|null} p.spend  null for an owned channel or when unavailable
 */
export function compareProvider({ provider, shopify, sessions, spend }) {
  const s = shopify ?? { netSales: 0, totalSales: 0, orders: 0, newCustomers: 0 };
  const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : { abs: a - b, pct: b !== 0 ? ((a - b) / b) * 100 : null });
  const per = (a, b) => (a === null || a === undefined || !(b > 0) ? null : a / b);
  return {
    spend,
    provider: provider
      ? {
          revenue: provider.revenue,
          conversions: provider.conversions,
          roas: spend === null ? null : per(provider.revenue, spend),
          cpa: spend === null ? null : per(spend, provider.conversions)
        }
      : null,
    shopify: {
      netSales: s.netSales,
      totalSales: s.totalSales,
      orders: s.orders,
      newCustomers: s.newCustomers,
      roas: spend === null ? null : per(s.netSales, spend),
      roasTotal: spend === null ? null : per(s.totalSales, spend),
      cpa: spend === null ? null : per(spend, s.orders),
      cac: spend === null ? null : per(spend, s.newCustomers),
      aov: per(s.netSales, s.orders),
      newCustomerShare: s.orders > 0 ? (s.newCustomers / s.orders) * 100 : null
    },
    sessions: sessions?.sessions ?? null,
    conversionRate: sessions && sessions.sessions > 0 ? (sessions.convertedSessions / sessions.sessions) * 100 : null,
    revenuePerSession: sessions && sessions.sessions > 0 ? s.netSales / sessions.sessions : null,
    difference: provider
      ? { revenue: diff(provider.revenue, s.totalSales), orders: diff(provider.conversions, s.orders) }
      : null
  };
}

/**
 * The channel-group rows of the attribution table: Shopify's attributed sales
 * and the sessions of each group, with the shares the table prints. Spend is
 * attached to a group only through its providers (Google Ads -> paid search),
 * never spread across groups.
 */
export function channelRows({ groups, salesByGroup, sessionsByGroup, spendByGroup = new Map() }) {
  const totalNet = [...salesByGroup.values()].reduce((t, r) => t + r.netSales, 0);
  const totalSessions = [...sessionsByGroup.values()].reduce((t, r) => t + r.sessions, 0);
  const totalSpend = [...spendByGroup.values()].reduce((t, v) => t + (v ?? 0), 0);
  return groups
    .map((group) => {
      const sales = salesByGroup.get(group) ?? { netSales: 0, totalSales: 0, orders: 0, newCustomers: 0 };
      const sess = sessionsByGroup.get(group) ?? null;
      const spend = spendByGroup.has(group) ? spendByGroup.get(group) : null;
      return {
        group,
        sessions: sess?.sessions ?? 0,
        convertedSessions: sess?.convertedSessions ?? 0,
        conversionRate: sess && sess.sessions > 0 ? (sess.convertedSessions / sess.sessions) * 100 : null,
        orders: sales.orders,
        netSales: sales.netSales,
        newCustomers: sales.newCustomers,
        aov: sales.orders > 0 ? sales.netSales / sales.orders : null,
        revenuePerSession: sess && sess.sessions > 0 ? sales.netSales / sess.sessions : null,
        newCustomerShare: sales.orders > 0 ? (sales.newCustomers / sales.orders) * 100 : null,
        revenueShare: totalNet > 0 ? (sales.netSales / totalNet) * 100 : null,
        sessionShare: totalSessions > 0 ? ((sess?.sessions ?? 0) / totalSessions) * 100 : null,
        spend,
        spendShare: spend !== null && totalSpend > 0 ? (spend / totalSpend) * 100 : null,
        roas: spend !== null && spend > 0 ? sales.netSales / spend : null,
        cac: spend !== null && sales.newCustomers > 0 ? spend / sales.newCustomers : null,
        cpa: spend !== null && sales.orders > 0 ? spend / sales.orders : null
      };
    })
    .filter((row) => row.sessions > 0 || row.orders > 0 || (row.spend ?? 0) > 0);
}

/**
 * How much of the website's attributed revenue Shopify could not place: the
 * `unknown` group's share of orders. 40% unknown is not 40% direct, and a
 * paid channel's Shopify figure is a floor by about this much.
 */
export function trackingCoverage(salesByGroup) {
  let orders = 0;
  let unknown = 0;
  for (const [group, row] of salesByGroup) {
    orders += row.orders;
    if (group === 'unknown') unknown += row.orders;
  }
  return { orders, unknownOrders: unknown, knownShare: orders > 0 ? ((orders - unknown) / orders) * 100 : null };
}
