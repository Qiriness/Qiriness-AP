/**
 * Server-only reader for mail the spam gate DROPPED.
 *
 * This is deliberately not a ticket reader. Dropped mail is never written to
 * `tickets` — the gate runs before the ticket write (see
 * agent/src/ingestion/delta-poller.mjs: "spam is dropped here — never written
 * to the database"), so the only trace is one `spam_audit` row per decision.
 * That row carries the sender, subject and a one-line reason. It does NOT carry
 * the body: nothing here can reconstruct the email, which is why promoting one
 * back into the queue needs the agent to re-fetch it from Graph rather than a
 * write from this module.
 *
 * Service-role key, same reason as the sibling services. Never import from a
 * client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseSelectAll } from "../../../scripts/lib/supabase-rest-client.mjs";
import type { DroppedMail } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/**
 * Every blocked decision, most recent first.
 *
 * Filtered on `outcome = 'blocked'` rather than on `label = 'irrelevant'`: the
 * blocklist pass writes no label at all, and the `irrelevant` label predates the
 * change that made it drop, so every row currently carrying it was in fact kept.
 * Blocked is the only field that reliably means "this never became a ticket".
 */
export async function listDroppedMail(shopId: string): Promise<DroppedMail[]> {
  const supabase = getSupabaseClient();

  const rows = await supabaseSelectAll(
    supabase,
    "spam_audit",
    { shop_id: shopId, outcome: { operator: "eq", value: "blocked" } },
    "id,graph_message_id,label,decided_by,reason,from_email,subject,failed_open,decided_at"
  );

  return (rows as any[])
    .map((row) => ({
      id: row.id,
      graphMessageId: row.graph_message_id,
      label: row.label ?? null,
      decidedBy: row.decided_by,
      reason: row.reason,
      fromEmail: row.from_email,
      subject: row.subject,
      failedOpen: Boolean(row.failed_open),
      decidedAt: row.decided_at,
    }))
    .sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0));
}
