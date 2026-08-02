/**
 * Server-only forwarding address book for the Agent Setup dashboard.
 *
 * Reads and writes `category_forwarding`: which colleague receives mail of a
 * given subject that asks nothing of customer support. The agent worker reads
 * the same table (agent/src/routing/forwarding-store.mjs) — this module owns
 * only the editing side.
 *
 * Uses the Supabase SERVICE ROLE key for the same reason knowledge-service does:
 * every table has RLS enabled with no policies, so only the service role can
 * read or write. Never import this from a client component.
 *
 * SAVING AN EMPTY ADDRESS MEANS "STOP FORWARDING". There is no separate enable
 * flag — an absent or blank address is the off switch, so clearing the field is
 * how an operator turns a category off. Two ways to express the same state could
 * disagree; one cannot.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { KnowledgeValidationError } from "./knowledge-errors";
import { TICKET_CATEGORIES, type CategoryForwarding, type KnowledgeCategory } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env));
}

/**
 * Every ticket category with its configured address, categories with no row
 * included as `null`. The UI always renders all 14 rows, so returning a sparse
 * list would make it reconstruct the missing ones itself.
 */
export async function listForwarding(shopId: string): Promise<CategoryForwarding[]> {
  const supabase = getSupabaseClient();
  const rows = await supabaseSelectAll(
    supabase,
    "category_forwarding",
    { shop_id: shopId },
    "category,forward_email"
  );

  const byCategory = new Map<string, string | null>(
    rows.map((row: { category: string; forward_email: string | null }) => [
      row.category,
      row.forward_email,
    ])
  );

  return TICKET_CATEGORIES.map((category) => ({
    category,
    forwardEmail: byCategory.get(category) ?? null,
  }));
}

/**
 * Upserts one category's address. Returns the saved row so the client renders
 * what the database actually holds rather than what it hoped it sent.
 */
export async function saveForwarding(
  shopId: string,
  category: string,
  forwardEmail: string | null
): Promise<CategoryForwarding> {
  if (!TICKET_CATEGORIES.includes(category as KnowledgeCategory)) {
    throw new KnowledgeValidationError(`"${category}" is not a ticket category.`);
  }

  const address = normaliseAddress(forwardEmail);
  if (forwardEmail && forwardEmail.trim() && !address) {
    throw new KnowledgeValidationError(
      `"${forwardEmail.trim()}" is not a valid email address.`
    );
  }

  const supabase = getSupabaseClient();
  await supabaseUpsert(
    supabase,
    "category_forwarding",
    [{ shop_id: shopId, category, forward_email: address }],
    "shop_id,category"
  );

  return { category: category as KnowledgeCategory, forwardEmail: address };
}

/**
 * Lowercased and trimmed, or null when the field is empty — empty is a valid
 * value here, it means "do not forward this category".
 *
 * The check is deliberately loose (something before an @, something after it,
 * a dot in the domain, no spaces). Whether an address really exists is decided
 * by Graph accepting the send, not by a regex trying to encode RFC 5322 — and a
 * regex that is too strict silently rejects a colleague's real address.
 */
function normaliseAddress(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}
