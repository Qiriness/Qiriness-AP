import { timingSafeEqual } from "node:crypto";
import { renderSalesReport } from "../../../../../scripts/lib/sales-report.mjs";
import { ReportMonthError, buildSalesReport } from "@/lib/server/insights/report-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Shorter than this, the secret is refused as unset: it guards revenue. */
const MIN_SECRET_LENGTH = 32;

/**
 * GET /api/reports/sales?month=YYYY-MM — the monthly sales report for the
 * WORKER, which mails it on the 1st (agent/src/reports/sales-report-mail.mjs).
 * The same report as /api/insights/report, built by the same service.
 *
 * PUBLIC TO THE MIDDLEWARE, like the webhooks: the worker holds no session.
 * Its proof is `Authorization: Bearer <SALES_REPORT_SECRET>`, compared in
 * constant time. With no secret configured the route answers 404, so a deploy
 * that has not set one exposes nothing.
 *
 * `month` is required: which month to mail is the worker's decision, taken on
 * the shop clock, not this route's.
 */
export async function GET(request: Request) {
  const secret = process.env.SALES_REPORT_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return new Response("Not found.", { status: 404 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }

  const month = new URL(request.url).searchParams.get("month");
  if (!month) return Response.json({ error: "month=YYYY-MM is required." }, { status: 400 });

  try {
    const html = renderSalesReport(await buildSalesReport(month));
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof ReportMonthError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[reports sales] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "The report could not be built." }, { status: 500 });
  }
}

function bearerMatches(header: string | null, secret: string) {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
