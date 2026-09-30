import type { SalesPanel } from "@/lib/types";
import { CollectionMix } from "./CollectionMix";
import { CountrySales } from "./CountrySales";
import { ProductCustomerMixCard } from "./ProductCustomerMixCard";
import { ProductPairs } from "./ProductPairs";
import { ProductPerformance } from "./ProductPerformance";
import { getFormat, getT } from "@/lib/i18n/server";
import { Card, DeltaChip, Grid, KpiCard } from "./InsightsKit";
import { SplitBar } from "./SplitBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { perGrain } from "./grain";
import styles from "./SalesView.module.css";

/** A colour per platform, fixed — never by rank, so a filter cannot repaint the survivors. */
const PLATFORM_COLORS: Record<string, string> = {
  shopify: "var(--chart-1)",
  amazon: "var(--chart-2)",
  yves_rocher: "var(--chart-3)",
};

/**
 * Sales over the chosen range and platform — the reference dashboard's layout:
 * revenue leads, then who bought and where, then the curve, then what sold.
 */
export function SalesView({ panel, compareLabel }: { panel: SalesPanel; compareLabel: string }) {
  const t = getT();
  const { euros, integer } = getFormat();
  const { current, previous } = panel.summary;
  const paidOrders = current.orders - current.cancelledOrders;
  const previousPaid = previous ? previous.orders - previous.cancelledOrders : null;
  const basket = paidOrders > 0 ? current.revenue / paidOrders : null;
  const previousBasket = previous && previousPaid ? previous.revenue / previousPaid : null;
  const grain = t(`insights.sales.per.${perGrain(panel.revenue)}`);
  const platformRevenue = panel.platforms.reduce((sum, p) => sum + p.revenue, 0);
  const mix = panel.customerMix;

  return (
    <>
      <Grid min={17} pin="headline" label={t("insights.sales.headlineRow")}>
        <KpiCard
          hero
          span={2}
          label={t("insights.sales.revenue")}
          value={euros(current.revenue, { cents: true })}
          delta={<DeltaChip current={current.revenue} previous={previous?.revenue} polarity="up" compareLabel={compareLabel} />}
          sub={[
            { label: t("insights.sales.avgPerDay"), value: euros(current.revenue / panel.days, { cents: true }) },
            // NOT Shopify's AOV, which is net sales over orders: this revenue
            // is Shopify's TOTAL sales, VAT and shipping included. Overview
            // carries the comparable figure.
            { label: t("insights.overview.aovFallback"), value: euros(basket, { cents: true }) },
            {
              label: t("insights.sales.refunded"),
              value: current.refundedAmount > 0 ? euros(current.refundedAmount, { cents: true }) : euros(0),
            },
          ]}
        />
        <KpiCard
          label={t("insights.overview.orders")}
          value={integer(paidOrders)}
          delta={<DeltaChip current={paidOrders} previous={previousPaid} polarity="up" compareLabel={compareLabel} />}
          sub={[
            {
              label: t("insights.sales.basketChange"),
              value:
                basket !== null && previousBasket !== null
                  ? `${basket >= previousBasket ? "+" : "−"}${euros(Math.abs(basket - previousBasket), { cents: true })}`
                  : "—",
            },
            { label: t("insights.sales.cancelled"), value: integer(current.cancelledOrders) },
          ]}
        />
        <Card title={t("insights.sales.newVsReturning")}>
          {mix ? (
            <SplitBar
              total={mix.newCustomerOrders + mix.returningCustomerOrders}
              parts={[
                {
                  key: "new",
                  label: t("insights.sales.newCustomers", { n: mix.newCustomers }),
                  value: mix.newCustomerOrders,
                  color: "var(--chart-1)",
                  display: t("insights.sales.ordersCount", { count: mix.newCustomerOrders }),
                },
                {
                  key: "returning",
                  label: t("insights.sales.returning", { n: mix.returningCustomers }),
                  value: mix.returningCustomerOrders,
                  color: "var(--chart-3)",
                  display: t("insights.sales.ordersCount", { count: mix.returningCustomerOrders }),
                },
              ]}
            />
          ) : (
            <p className={styles.note}>
              {t("insights.sales.marketplaceNote")}
            </p>
          )}
        </Card>
      </Grid>

      <Grid min={17} pin="platforms" label={t("insights.sales.byPlatform")}>
        <Card title={t("insights.sales.byPlatform")} span={2}>
          <SplitBar
            total={platformRevenue}
            parts={panel.platforms.map((p) => ({
              key: p.platform,
              label: p.label,
              value: p.revenue,
              color: PLATFORM_COLORS[p.platform] ?? "var(--chart-4)",
              display: (
                <>
                  {euros(p.revenue, { cents: true })}{" "}
                  <span className={styles.dim}>· {t("insights.sales.ordersCount", { count: p.orders })}</span>
                </>
              ),
            }))}
          />
        </Card>
        <KpiCard
          label={t("insights.overview.units")}
          value={integer(panel.products.global.products.reduce((sum, p) => sum + p.units, 0))}
          sub={[{ label: t("insights.sales.productsSold"), value: integer(panel.products.global.products.length) }]}
        />
      </Grid>

      <Grid min={100} pin="revenue-chart" label={t("insights.sales.chart")}>
        <Card title={t("insights.sales.revenuePer", { grain })}>
          <TimeSeriesChart points={panel.revenue} unit="euro" ariaLabel={t("insights.sales.revenuePer", { grain })} height={320} missingLabel="insights.sales.notSynced" />
        </Card>
      </Grid>

      {/* The pin id stays `best-products` through the rename: changing it would
          forget the pin for anyone who had set one (PinBoard.tsx). */}
      <Grid min={30} pin="best-products" label={t("insights.sales.productRow")}>
        <Card title={t("insights.sales.productPerformance")} span={2} aside={<span>{t("insights.kit.vs", { label: compareLabel })}</span>}>
          <ProductPerformance products={panel.products} compareLabel={compareLabel} />
        </Card>
        <Card title={t("insights.sales.collectionMix")} aside={<span>{t("insights.sales.collectionsOverlap")}</span>}>
          <CollectionMix
            collections={panel.collections}
            productRevenue={panel.productRevenue}
            compareLabel={compareLabel}
          />
        </Card>
      </Grid>

      <Grid min={17} pin="countries-pairs" label={t("insights.sales.countriesRow")}>
        <Card title={t("insights.sales.byCountry")}>
          <CountrySales countries={panel.countries} />
        </Card>
        <Card title={t("insights.sales.boughtTogether")} span={2}>
          <ProductPairs groups={panel.pairs} />
        </Card>
      </Grid>

      <Grid min={100} pin="product-customer-mix" label={t("insights.sales.whoBuys")}>
        <Card title={t("insights.sales.whoBuys")}>
          <ProductCustomerMixCard mix={panel.productCustomerMix} />
        </Card>
      </Grid>
    </>
  );
}
