import type { CustomerActivity } from "@/lib/types";
import { ColumnChart } from "./ColumnChart";
import { getFormat, getT } from "@/lib/i18n/server";
import { Card, Grid, KpiCard } from "./InsightsKit";

/**
 * What customers did inside the selected range: how often they ordered.
 * Shopify customers only — marketplaces mint one customer per order.
 *
 * THE NEWSLETTER USED TO BE HERE and moved to Marketing & funnel (2026-09-23):
 * the list is a marketing channel, and the reader asking how it moved is the
 * one reading acquisition and promotions. See NewsletterRows.
 *
 * Server-rendered; the charts are client islands handed finished data.
 */
export function CustomerActivityRows({ activity }: { activity: CustomerActivity }) {
  const t = getT();
  const { integer, decimal, percent } = getFormat();

  // --- orders per customer
  const buyers = activity.ordersPerCustomer.reduce((sum, b) => sum + b.customers, 0);
  const repeat = activity.ordersPerCustomer.filter((b) => b.orders > 1).reduce((sum, b) => sum + b.customers, 0);
  // "10 or more" counts as 10 here, so the average is a floor when that column is non-empty.
  const orders = activity.ordersPerCustomer.reduce((sum, b) => sum + b.orders * b.customers, 0);

  return (
    <>
      <Grid min={17} pin="orders-per-customer" label={t("insights.customers.byOrders")}>
        <Card title={t("insights.customers.byOrders")} span={2}>
          <ColumnChart
            unit="count"
            ariaLabel={t("insights.customers.byOrdersAria")}
            xTitle={t("insights.customers.xTitle")}
            height={240}
            series={[{ label: t("insights.sales.customers"), color: "var(--chart-line)" }]}
            data={activity.ordersPerCustomer.map((b) => ({
              key: String(b.orders),
              label: b.orMore ? `${b.orders}+` : String(b.orders),
              title: b.orMore ? t("insights.sales.mix.orMore", { n: b.orders }) : t("insights.sales.ordersCount", { count: b.orders }),
              segments: [b.customers],
              top: b.customers === 0 ? undefined : b.customers / buyers < 0.005 ? "<1%" : percent(b.customers, buyers, 0),
              note: t("insights.customers.ofOrdered", { pct: percent(b.customers, buyers) }),
            }))}
          />
        </Card>
        <KpiCard
          label={t("insights.customers.ordered")}
          value={integer(buyers)}
          sub={[
            { label: t("insights.customers.repeat"), value: percent(repeat, buyers) },
            { label: t("insights.customers.perCustomer"), value: buyers ? decimal(orders / buyers, 2) : "—" },
          ]}
        />
      </Grid>
    </>
  );
}
