import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/AppShell";
import { OrderDetailView } from "@/components/orders/OrderDetailView";
import { getShopId } from "@/lib/server/knowledge-service";
import { getOrderDetail } from "@/lib/server/orders-service";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { logDashboardAccess } from "@/lib/server/access-log";
import type { OrderDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Order · Qiriness Support OS" };

/** Only our own ticket ids come back as a link, never an arbitrary destination. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One order in full: what it holds, where it went, what was paid, and who wrote about it. */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: { id: string };
  // Set when the page was opened from a ticket's Order block, so the reader can
  // go straight back to the ticket they were reading rather than to the queue.
  searchParams?: { ticket?: string };
}) {
  const badges = await navBadgeCounts();
  let order: OrderDetail | null = null;
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    order = await getOrderDetail(shopId, params.id);
    if (order) {
      await logDashboardAccess({
        shopId,
        action: "view",
        resourceType: "orders",
        resourceId: order.orderId,
        purpose: "order_lookup",
        metadata: { surface: "order_detail", tickets: order.tickets.length },
      });
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load this order.";
  }

  // Outside the try: notFound() throws, and the catch would turn it into an error message.
  if (!order && !loadError) notFound();

  return (
    <AppShell activeHref="/orders" {...badges}>
      <OrderDetailView
        order={order}
        loadError={loadError}
        backToTicketId={searchParams?.ticket && UUID.test(searchParams.ticket) ? searchParams.ticket : null}
      />
    </AppShell>
  );
}
