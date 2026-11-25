import type { Compared, OrdersSummary, PromotionRow } from "@/lib/types";
import type { PromotionsSection as Section } from "@/lib/server/insights/promotions-service";
import { getFormat, getT } from "@/lib/i18n/server";
import { Caption, Card, DeltaChip, Grid, KpiCard } from "./InsightsKit";
import t from "./tables.module.css";
import styles from "./PromotionsSection.module.css";

/**
 * Promotions, discounts and gifts on the Sales panel: how much was given, how
 * many orders carried an offer, full-price revenue, and what each promotion
 * recorded on its orders. Moved here unchanged from Marketing & funnel
 * (2026-11-25); DECISIONS.md § Insights → « Overview, Marketing & funnel… »
 * still defines « Discounts & gifts ».
 */
export function PromotionsSection({ section, summary, compareLabel }: { section: Section; summary: Compared<OrdersSummary>; compareLabel: string }) {
  const tr = getT();
  const { euros, integer, percent, percentOf } = getFormat();
  const f = section.figures.current;
  const fb = section.figures.previous;
  const gross = summary.current.grossRevenue + f.discounts;
  const discountShare = gross > 0 ? (f.discounts / gross) * 100 : null;
  const previousGross = summary.previous && fb ? summary.previous.grossRevenue + fb.discounts : null;
  const previousShare = previousGross && fb ? (fb.discounts / previousGross) * 100 : null;
  return (
    <>
      <Grid min={14} pin="promotions-headline" label={tr("insights.marketing.promotions")}>
        <KpiCard
          label={tr("insights.marketing.discounts")}
          value={euros(f.discounts)}
          delta={<DeltaChip current={f.discounts} previous={fb?.discounts} polarity="down" compareLabel={compareLabel} />}
          sub={[{ label: tr("insights.marketing.shareGross"), value: discountShare === null ? "—" : percentOf(discountShare, 1) }]}
        />
        <KpiCard
          label={tr("insights.marketing.withPromo")}
          value={integer(f.discountedOrders)}
          unit={tr("insights.fulfilment.of", { total: integer(f.paidOrders) })}
          delta={<DeltaChip current={discountShare} previous={previousShare} polarity="down" points compareLabel={compareLabel} />}
          sub={[{ label: tr("insights.marketing.shareOrders"), value: percent(f.discountedOrders, f.paidOrders) }]}
        />
        <KpiCard
          label={tr("insights.marketing.fullPrice")}
          value={euros(f.fullPriceRevenue)}
          delta={<DeltaChip current={f.fullPriceRevenue} previous={fb?.fullPriceRevenue} polarity="up" compareLabel={compareLabel} />}
          sub={[
            { label: tr("insights.marketing.discountedAov"), value: euros(f.discountedOrders > 0 ? f.discountedRevenue / f.discountedOrders : null, { cents: true }) },
            {
              label: tr("insights.marketing.fullAov"),
              value: euros(f.paidOrders - f.discountedOrders > 0 ? f.fullPriceRevenue / (f.paidOrders - f.discountedOrders) : null, { cents: true }),
            },
          ]}
        />
      </Grid>
      <Grid min={30} pin="promotions" label={tr("insights.marketing.promotions")}>
        <Card title={tr("insights.marketing.promotions")} span={3} aside={<span>{tr("insights.marketing.promotionsAside")}</span>}>
          <PromotionTable rows={section.rows} />
        </Card>
      </Grid>
    </>
  );
}

/**
 * One row per promotion, full price last. An order carrying two promotions
 * counts in both, so the rows do not sum; the caption says so. A shipping
 * promotion takes nothing off a line, so its discount cell says "shipping"
 * instead of a zero.
 */
function PromotionTable({ rows }: { rows: PromotionRow[] }) {
  const tr = getT();
  const { euros, integer } = getFormat();
  if (rows.every((r) => r.orders === 0)) return <p className={t.muted}>{tr("insights.marketing.noOrders")}</p>;
  return (
    <>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th scope="col">{tr("insights.marketing.promotion")}</th>
              <th scope="col" className={t.n}>{tr("insights.sales.revenue")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.orders")}</th>
              <th scope="col" className={t.n}>{tr("insights.overview.aov")}</th>
              <th scope="col" className={t.n} title={tr("insights.marketing.discountHint")}>
                {tr("insights.marketing.discount")}
              </th>
              <th scope="col" className={t.n} title={tr("insights.marketing.newHint")}>
                {tr("insights.marketing.newCust")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name ?? "__full_price"}>
                <th scope="row" className={styles.promoName} title={row.name ?? tr("insights.marketing.noPromo")}>
                  {row.name ?? tr("insights.marketing.noPromoFull")}
                  {row.kind === "code" ? <span className={styles.kind}>{tr("insights.marketing.code")}</span> : null}
                </th>
                <td className={t.n}>{euros(row.revenue)}</td>
                <td className={t.n}>{integer(row.orders)}</td>
                <td className={t.n}>{euros(row.orders > 0 ? row.revenue / row.orders : null, { cents: true })}</td>
                <td className={t.n}>
                  {row.name === null ? (
                    <span className={t.muted}>—</span>
                  ) : row.target === "SHIPPING_LINE" ? (
                    <span className={t.muted}>{tr("insights.marketing.shipping")}</span>
                  ) : (
                    euros(row.discount)
                  )}
                </td>
                <td className={t.n}>{row.newCustomerOrders === null ? "—" : integer(row.newCustomerOrders)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caption>{tr("insights.marketing.promoNote")}</Caption>
    </>
  );
}
