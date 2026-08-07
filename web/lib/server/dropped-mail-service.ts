/**
 * Server-only reader for mail the spam gate DROPPED.
 *
 * This is deliberately not a ticket reader. Dropped mail is never written to
 * `tickets` — the gate runs before the ticket write (see
 * agent/src/ingestion/delta-poller.mjs: "spam is dropped here — never written
 * to the database"), so the only trace is one `spam_audit` row per decision.
 * That row carries the sender, subject, a one-line reason and — since
 * 04_support.sql — the cleaned body, because the one question a reviewer
 * has is "should this have become a ticket?" and a subject line does not answer
 * it. The body has a bounded life (the worker nulls it past `body_expires_at`)
 * while the decision row is kept, so an older row legitimately has none.
 *
 * Still not a ticket reader, and promoting one back into the queue still needs
 * the agent to re-fetch from Graph rather than a write from this module: a body
 * is not a `ticket_messages` row.
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
    "id,graph_message_id,label,decided_by,reason,from_email,subject," +
      "body_text,body_captured_at,body_expires_at,failed_open,decided_at"
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
      body: row.body_text ?? null,
      bodyCapturedAt: row.body_captured_at ?? null,
      bodyExpiresAt: row.body_expires_at ?? null,
      failedOpen: Boolean(row.failed_open),
      decidedAt: row.decided_at,
    }))
    .sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0));
}
