import type { SalesPanel } from "@/lib/types";
import { BestProducts } from "./BestProducts";
import { CountrySales } from "./CountrySales";
import { ProductCustomerMixCard } from "./ProductCustomerMixCard";
import { ProductPairs } from "./ProductPairs";
import { Card, DeltaChip, Grid, KpiCard, euros } from "./InsightsKit";
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
  const { current, previous } = panel.summary;
  const paidOrders = current.orders - current.cancelledOrders;
  const previousPaid = previous ? previous.orders - previous.cancelledOrders : null;
  const basket = paidOrders > 0 ? current.revenue / paidOrders : null;
  const previousBasket = previous && previousPaid ? previous.revenue / previousPaid : null;
  const grain = perGrain(panel.revenue);
  const platformRevenue = panel.platforms.reduce((sum, p) => sum + p.revenue, 0);
  const mix = panel.customerMix;

  return (
    <>
      <Grid min={17} pin="headline" label="Revenue, orders and customer mix">
        <KpiCard
          hero
          span={2}
          label="Revenue"
          value={euros(current.revenue, { cents: true })}
          delta={<DeltaChip current={current.revenue} previous={previous?.revenue} polarity="up" compareLabel={compareLabel} />}
          sub={[
            { label: "Average per day", value: euros(current.revenue / panel.days, { cents: true }) },
            { label: "Average basket", value: euros(basket, { cents: true }) },
            {
              label: "Refunded",
              value: current.refundedAmount > 0 ? euros(current.refundedAmount, { cents: true }) : "0 €",
            },
          ]}
        />
        <KpiCard
          label="Orders"
          value={paidOrders.toLocaleString("en-GB")}
          delta={<DeltaChip current={paidOrders} previous={previousPaid} polarity="up" compareLabel={compareLabel} />}
          sub={[
            {
              label: "Basket change",
              value:
                basket !== null && previousBasket !== null
                  ? `${basket >= previousBasket ? "+" : "−"}${euros(Math.abs(basket - previousBasket), { cents: true })}`
                  : "—",
            },
            { label: "Cancelled", value: current.cancelledOrders.toLocaleString("en-GB") },
          ]}
        />
        <Card title="New vs returning">
          {mix ? (
            <SplitBar
              total={mix.newCustomerOrders + mix.returningCustomerOrders}
              parts={[
                {
                  key: "new",
                  label: `New customers (${mix.newCustomers})`,
                  value: mix.newCustomerOrders,
                  color: "var(--chart-1)",
                  display: `${mix.newCustomerOrders} orders`,
                },
                {
                  key: "returning",
                  label: `Returning (${mix.returningCustomers})`,
                  value: mix.returningCustomerOrders,
                  color: "var(--chart-3)",
                  display: `${mix.returningCustomerOrders} orders`,
                },
              ]}
            />
          ) : (
            <p className={styles.note}>
              Marketplaces create a new customer record for every order, so new and returning cannot be told apart.
            </p>
          )}
        </Card>
      </Grid>

      <Grid min={17} pin="platforms" label="Revenue by platform">
        <Card title="Revenue by platform" span={2}>
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
                  <span className={styles.dim}>· {p.orders} orders</span>
                </>
              ),
            }))}
          />
        </Card>
        <KpiCard
          label="Units sold"
          value={panel.products.global.products.reduce((sum, p) => sum + p.units, 0).toLocaleString("en-GB")}
          sub={[{ label: "Products sold", value: panel.products.global.products.length.toLocaleString("en-GB") }]}
        />
      </Grid>

      <Grid min={100} pin="revenue-chart" label="Revenue chart">
        <Card title={`Revenue ${grain}`}>
          <TimeSeriesChart points={panel.revenue} unit="euro" ariaLabel={`Revenue ${grain}`} height={320} missingLabel="Not synced from Shopify yet" />
        </Card>
      </Grid>

      <Grid min={100} pin="best-products" label="Best products">
        <Card title="Best products">
          <BestProducts products={panel.products} />
        </Card>
      </Grid>

      <Grid min={17} pin="countries-pairs" label="Sales by country and bought together">
        <Card title="Sales by country">
          <CountrySales countries={panel.countries} />
        </Card>
        <Card title="Bought together" span={2}>
          <ProductPairs groups={panel.pairs} />
        </Card>
      </Grid>

      <Grid min={100} pin="product-customer-mix" label="Who buys this product">
        <Card title="Who buys this product">
          <ProductCustomerMixCard mix={panel.productCustomerMix} />
        </Card>
      </Grid>
    </>
  );
}
