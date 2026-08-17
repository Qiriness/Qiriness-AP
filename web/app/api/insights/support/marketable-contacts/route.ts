import { getShopId } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import { listMarketableContacts, toCsv } from "@/lib/server/insights/marketable-contacts";

export const dynamic = "force-dynamic";

/**
 * The consented outreach list, as a CSV download.
 *
 * A ROUTE RATHER THAN A CLIENT-SIDE BLOB. Building the file in the browser would
 * mean shipping every name and address into the page on every render of the
 * Support panel, whether or not anyone downloads it — the panel is otherwise
 * entirely aggregates, and that is worth keeping. Here the personal data leaves
 * the database only when somebody actually asks for the file, and that ask is
 * the thing `listMarketableContacts` writes an audit row for.
 *
 * `force-dynamic` and `no-store` together: a cached export is a stale list of
 * people, and one served to a later visitor is a disclosure nobody asked for.
 */
export async function GET() {
  try {
    const shopId = await getShopId();
    const contacts = await listMarketableContacts(shopId);
    const date = new Date().toISOString().slice(0, 10);

    return new Response(toCsv(contacts), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="qiriness-marketable-contacts-${date}.csv"`,
        "Cache-Control": "no-store, max-age=0"
      }
    });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
