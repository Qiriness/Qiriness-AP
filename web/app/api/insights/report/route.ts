import { canAccessPath } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { lastCompleteMonth } from "../../../../../scripts/lib/insights-range.mjs";
import { renderSalesReport, reportFileName } from "../../../../../scripts/lib/sales-report.mjs";
import { getSession } from "@/lib/server/auth";
import { getShop } from "@/lib/server/shop";
import { ReportMonthError, buildSalesReport } from "@/lib/server/insights/report-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/insights/report?month=YYYY-MM — the monthly sales report as an HTML
 * download. Without `month`, the last month that has ended on the shop clock:
 * what the report sent at the start of a month covers.
 *
 * The role is checked here as well as in the middleware, as the panels do:
 * the report leads with revenue, which the contact team does not see.
 *
 * Aggregates and product names only — no customer is named — so no access row
 * is written. `no-store`: a month still in progress changes by the minute.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
  if (!canAccessPath(session.role, "/api/insights/report")) {
    return Response.json({ error: "Your role cannot open this." }, { status: 403 });
  }

  try {
    const requested = new URL(request.url).searchParams.get("month");
    const shop = await getShop();
    const month = requested ?? lastCompleteMonth({ tz: shop?.ianaTimezone ?? "UTC" });
    const html = renderSalesReport(await buildSalesReport(month));
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${reportFileName(month)}"`,
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof ReportMonthError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[insights report] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "The report could not be built." }, { status: 500 });
  }
}
