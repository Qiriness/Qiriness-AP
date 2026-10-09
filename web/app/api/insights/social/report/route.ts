import { canAccessPath } from "../../../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { getLocale } from "@/lib/i18n/server";
import { buildSocialReport, SocialReportInputError } from "@/lib/server/insights/social-report-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
  if (!canAccessPath(session.role, "/insights/social")) return Response.json({ error: "Your role cannot open this." }, { status: 403 });
  try {
    const report = await buildSocialReport(new URL(request.url).searchParams, getLocale());
    return new Response(report.html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + report.filename + '"',
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof SocialReportInputError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[social report] build failed");
    return Response.json({ error: "The report could not be built." }, { status: 500 });
  }
}
