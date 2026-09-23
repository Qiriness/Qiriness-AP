import type { CustomerActivity } from "@/lib/types";
import { ColumnChart } from "./ColumnChart";
import { Card, Grid, KpiCard, percent } from "./InsightsKit";

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

  // --- orders per customer
  const buyers = activity.ordersPerCustomer.reduce((sum, b) => sum + b.customers, 0);
  const repeat = activity.ordersPerCustomer.filter((b) => b.orders > 1).reduce((sum, b) => sum + b.customers, 0);
  // "10 or more" counts as 10 here, so the average is a floor when that column is non-empty.
  const orders = activity.ordersPerCustomer.reduce((sum, b) => sum + b.orders * b.customers, 0);

  return (
    <>
      <Grid min={17} pin="orders-per-customer" label="Customers by number of orders">
        <Card title="Customers by number of orders" span={2}>
          <ColumnChart
            unit="count"
            ariaLabel="Customers by how many orders they placed in the selected range"
            xTitle="Orders placed in the range"
            height={240}
            series={[{ label: "Customers", color: "var(--chart-line)" }]}
            data={activity.ordersPerCustomer.map((b) => ({
              key: String(b.orders),
              label: b.orMore ? `${b.orders}+` : String(b.orders),
              title: b.orMore
                ? `${b.orders} or more orders`
                : `${b.orders} ${b.orders === 1 ? "order" : "orders"}`,
              segments: [b.customers],
              top: b.customers === 0 ? undefined : b.customers / buyers < 0.005 ? "<1%" : percent(b.customers, buyers, 0),
              note: `${percent(b.customers, buyers)} of customers who ordered`,
            }))}
          />
        </Card>
        <KpiCard
          label="Customers who ordered"
          value={buyers.toLocaleString("en-GB")}
          sub={[
            { label: "Ordered more than once", value: percent(repeat, buyers) },
            { label: "Orders per customer", value: buyers ? (orders / buyers).toFixed(2) : "—" },
          ]}
        />
      </Grid>
    </>
  );
}
