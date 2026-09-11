import { InsightsPage } from "@/components/insights/InsightsPage";
import { CustomersView } from "@/components/insights/CustomersView";
import { CustomerActivityRows } from "@/components/insights/CustomerActivityRows";
import { getCustomersPanel } from "@/lib/server/insights/customers-service";
import { getCustomerActivity } from "@/lib/server/insights/customer-activity-service";
import type { SearchParams } from "@/lib/server/insights/context";

export const dynamic = "force-dynamic";

export const metadata = { title: "Customers · Insights · Qiriness Support OS" };

/**
 * The customer base today (a snapshot), plus what customers did in the selected
 * range. The platform control stays disabled: every per-person figure leaves out
 * marketplaces, which create one customer per order. The view is a client
 * component (the call list re-sorts); the ranged rows are rendered here and
 * handed in as a slot, so nothing server-only crosses the boundary.
 */
export default function CustomersInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <InsightsPage
      active="customers"
      scope={{
        range: true,
        platform: false,
        platformReason: "Per-person figures leave out Amazon and Yves Rocher, which create one customer per order",
      }}
      searchParams={searchParams}
      render={async (ctx) => {
        const [panel, activity] = await Promise.all([getCustomersPanel(ctx.shopId), getCustomerActivity(ctx)]);
        return (
          <CustomersView
            panel={panel}
            ranged={
              <CustomerActivityRows activity={activity} grain={ctx.range.grain} compareLabel={ctx.range.compareLabel} />
            }
          />
        );
      }}
    />
  );
}
