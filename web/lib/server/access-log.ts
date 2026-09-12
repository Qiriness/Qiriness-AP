/**
 * One `data_access_events` row each time a signed-in person is shown customers
 * by name — the human half of the access trail the sync and the agent already
 * write (SHOPIFY_PERSONAL_DATA_PROTECTION.md item 15).
 *
 * WHO, NOT WHAT. The actor is the dashboard user's id; the resource, when there
 * is one, is hashed like every other row in the table, and the metadata carries
 * counts and the surface, never a name or an address. The trail must not itself
 * become a copy of the customer list.
 *
 * FAILS OPEN, like every audit write here: the data has already been read, and
 * a failed insert should not also cost the operator the page. It is logged.
 *
 * Server-only.
 */

import { hashIdentifier, recordDataAccessEvent } from "../../../scripts/lib/compliance-audit.mjs";
import { getSession } from "./auth";
import { getSupabaseClient } from "./insights/shared";

export interface DashboardAccess {
  shopId: string;
  action: "view" | "view_thread" | "export";
  resourceType: "ticket" | "tickets" | "customer" | "customers" | "orders";
  /** A single record's id, hashed before it is stored. Omit for a list. */
  resourceId?: string | null;
  purpose: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function logDashboardAccess(entry: DashboardAccess): Promise<void> {
  try {
    const session = await getSession();
    await recordDataAccessEvent(getSupabaseClient(), {
      shop_id: entry.shopId,
      actor_type: "user",
      // The middleware lets nothing unsigned this far; "unknown" is the honest
      // label if that ever stops being true, rather than a skipped row.
      actor_id: session?.sub ?? "unknown",
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id_hash: entry.resourceId ? hashIdentifier(entry.resourceId) : null,
      purpose: entry.purpose,
      metadata: { ...(entry.metadata ?? {}), role: session?.role ?? null },
    });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "access_log.failed", message: error instanceof Error ? error.message : String(error) })
    );
  }
}
