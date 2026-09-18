import { AppShell } from "@/components/app-shell/AppShell";
import { OrdersView } from "@/components/orders/OrdersView";
import { getShopId } from "@/lib/server/knowledge-service";
import { listOrders } from "@/lib/server/orders-service";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { timed } from "@/lib/server/timing";
import { logDashboardAccess } from "@/lib/server/access-log";
import type { OrderListPage } from "@/lib/types";
import { parseOrderListQuery } from "../../../scripts/lib/order-list-query.mjs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Orders · Qiriness Support OS" };

/**
 * Orders — every Shopify order, as the Shopify admin lists them, so looking one
 * up does not mean leaving the app.
 *
 * THE URL IS THE STATE, as on Insights: status, country, VIP and page live in
 * the query string and the server re-renders against it. The list is paged in
 * SQL; 6,000 orders do not travel to the browser.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Started, not awaited: the badges are read beside this page's own data
  // rather than before it. navBadgeCounts never throws.
  const badgesRead = timed("badges", navBadgeCounts());
  let page: OrderListPage | null = null;
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    page = await timed("orders list", listOrders(shopId, parseOrderListQuery(searchParams)));
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "orders",
      purpose: "order_lookup",
      metadata: { surface: "orders", orders: page.rows.length },
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load orders.";
  }

  const badges = await badgesRead;
  return (
    <AppShell activeHref="/orders" {...badges}>
      <OrdersView page={page} loadError={loadError} />
    </AppShell>
  );
}
