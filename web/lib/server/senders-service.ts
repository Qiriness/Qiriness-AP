/**
 * The sender directory: who a sender is to this business, by address or domain.
 *
 * Until 2026-09-27 the rows were written straight into the database, so a new
 * brand needed a developer to say « deret.fr is our warehouse ». This is the
 * Agent Setup screen's service (stage 5 of codex_plans/Case_State_Plan.md).
 *
 * WHAT A ROW MEANS FOR A CASE is shown beside it, through the same actor map
 * the agent uses (AGENT_ACTOR_BY_LABEL): a label decides whether that sender's
 * mail is a customer's, a colleague's or an operations partner's, and whether
 * « operations partner » is offered as an owner of checks at all.
 *
 * Server-only (service role).
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseUpdateById,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { normalizeDomain, normalizeEmail } from "../../../scripts/lib/sender-patterns.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { loadAgentConfig } from "../../../agent/src/config.mjs";
import { obligationOwners } from "../../../agent/src/casework/actors.mjs";
import { KnowledgeValidationError } from "./knowledge-errors";
import { SENDER_LABEL_KEYS } from "../types";
import type { SenderActor, SenderDirectoryEntry, SenderDirectoryView, SenderLabel } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

function actorMap(): Record<string, SenderActor> {
  return (loadAgentConfig().actorByLabel ?? {}) as Record<string, SenderActor>;
}

/** Who may owe a check in this brand, from its sender directory (`obligationOwners`). */
export async function checkOwnersFor(shopId: string): Promise<string[]> {
  const rows = await supabaseSelect(getSupabaseClient(), T.SENDER_DIRECTORY, { shop_id: shopId }, "label");
  const labels = [...new Set((Array.isArray(rows) ? rows : []).map((row: any) => String(row.label)))];
  return (obligationOwners as unknown as (a: Record<string, unknown>) => string[])({ labels, actorByLabel: actorMap() });
}

export async function listSenders(shopId: string): Promise<SenderDirectoryView> {
  const rows = await supabaseSelect(
    getSupabaseClient(),
    T.SENDER_DIRECTORY,
    { shop_id: shopId },
    "id,pattern_type,pattern,label,note",
    { order: "label.asc" }
  );
  const map = actorMap();
  const entries: SenderDirectoryEntry[] = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: row.id,
    patternType: row.pattern_type,
    pattern: row.pattern,
    label: row.label,
    note: row.note ?? null,
    actor: map[row.label] ?? "customer",
  }));
  const owners = (obligationOwners as unknown as (a: Record<string, unknown>) => string[])({
    labels: [...new Set(entries.map((e) => e.label))],
    actorByLabel: map,
  });
  return {
    entries,
    hasOperationsPartner: owners.includes("partner"),
    supportMailboxDomain: (loadAgentConfig().graph?.mailbox ?? "").split("@")[1] ?? null,
  };
}

function validLabel(label: unknown): SenderLabel {
  if (typeof label !== "string" || !(SENDER_LABEL_KEYS as readonly string[]).includes(label)) {
    throw new KnowledgeValidationError(`label must be one of ${SENDER_LABEL_KEYS.join(", ")}.`);
  }
  return label as SenderLabel;
}

/** A new row. The pattern is normalised exactly as the matcher reads it. */
export async function addSender(
  shopId: string,
  input: { patternType?: unknown; pattern?: unknown; label?: unknown; note?: unknown }
): Promise<SenderDirectoryView> {
  const patternType = input.patternType === "email" ? "email" : input.patternType === "domain" ? "domain" : null;
  if (!patternType) throw new KnowledgeValidationError("patternType must be email or domain.");
  const raw = typeof input.pattern === "string" ? input.pattern : "";
  const pattern = patternType === "email" ? normalizeEmail(raw) : normalizeDomain(raw);
  if (!pattern) throw new KnowledgeValidationError("Enter an address or a domain.");
  if (patternType === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pattern)) {
    throw new KnowledgeValidationError("That is not an email address.");
  }
  if (patternType === "domain" && (pattern.includes("@") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(pattern))) {
    throw new KnowledgeValidationError("That is not a domain (for example deret.fr).");
  }
  const label = validLabel(input.label);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;

  const supabase = getSupabaseClient();
  const existing = await supabaseSelect(supabase, T.SENDER_DIRECTORY, { shop_id: shopId, pattern_type: patternType, pattern }, "id");
  if (Array.isArray(existing) && existing.length > 0) {
    throw new KnowledgeValidationError(`${pattern} is already in the directory.`);
  }
  await supabaseInsert(supabase, T.SENDER_DIRECTORY, [{ shop_id: shopId, pattern_type: patternType, pattern, label, note }]);
  return listSenders(shopId);
}

/** A row's label or note. The pattern itself is not edited: delete and add. */
export async function updateSender(
  shopId: string,
  id: string,
  input: { label?: unknown; note?: unknown }
): Promise<SenderDirectoryView> {
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) patch.label = validLabel(input.label);
  if (input.note !== undefined) patch.note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  const supabase = getSupabaseClient();
  const rows = await supabaseSelect(supabase, T.SENDER_DIRECTORY, { id, shop_id: shopId }, "id");
  if (!Array.isArray(rows) || rows.length === 0) throw new KnowledgeValidationError("No such sender.");
  await supabaseUpdateById(supabase, T.SENDER_DIRECTORY, id, patch);
  return listSenders(shopId);
}

export async function deleteSender(shopId: string, id: string): Promise<SenderDirectoryView> {
  await supabaseDelete(getSupabaseClient(), T.SENDER_DIRECTORY, { id, shop_id: shopId });
  return listSenders(shopId);
}
