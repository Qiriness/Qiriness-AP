/**
 * The case's current state for the ticket page, and the one action a person
 * takes on it: marking an open check done or cancelled.
 *
 * Stage 5 of codex_plans/Case_State_Plan.md. `case_current` is written by the
 * agent's fold; this service READS it, and writes only `ticket_case_actions`.
 * After an action it re-folds that ticket at once with the agent's own fold, so
 * the page shows the result without waiting for the worker's next poll.
 *
 * Server-only: it uses the service role. Never import from a client component.
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseInsert, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { days, toParameterMap } from "../../../scripts/lib/parameters.mjs";
import { loadAgentConfig } from "../../../agent/src/config.mjs";
import { actorOf } from "../../../agent/src/casework/actors.mjs";
import { obligationAges } from "../../../agent/src/casework/case-fold.mjs";
import { createCaseCurrentStore, runFold } from "../../../agent/src/casework/case-current-store.mjs";
import { createSenderDirectoryStore } from "../../../agent/src/ingestion/sender-directory.mjs";
import { AUTO_CLOSE_EXEMPT_LEVELS } from "../../../agent/src/lifecycle/auto-close.mjs";
import { needLabel } from "../need-labels";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import { MISSING_FIELD_LABELS } from "../types";
import type { MissingField, TicketCaseState, TicketObligation } from "../types";

const ACTIONS = new Set(["fulfilled", "cancelled"]);

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/** The two overdue delays, per owner, from the shop's parameters. */
async function overdueDelays(supabase: unknown, shopId: string) {
  const map = toParameterMap(
    await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, "parameter_key,value")
  );
  return {
    colleague: days(map, "colleague_check_overdue_days"),
    partner: days(map, "partner_check_overdue_days"),
  };
}

/** The case as the page shows it, or null when the fold has not reached it. */
export async function getCaseState(shopId: string, ticketId: string): Promise<TicketCaseState | null> {
  const supabase = getSupabaseClient();
  const [rows, delays] = await Promise.all([
    supabaseSelect(
      supabase,
      T.CASE_CURRENT,
      { ticket_id: ticketId, shop_id: shopId },
      "next_actor,version,folded_at,pending_customer_inputs,obligations"
    ),
    overdueDelays(supabase, shopId),
  ]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  const aged = obligationAges(Array.isArray(row.obligations) ? row.obligations : [], { delays });
  const obligations: TicketObligation[] = aged.map((o: any) => ({
    id: String(o.id),
    owner: o.owner,
    need: o.need,
    needLabel: needLabel(o.need),
    status: o.status,
    openedAt: o.opened_at ?? null,
    workingDaysOpen: o.workingDaysOpen ?? null,
    overdue: Boolean(o.overdue),
    clearedManually: o.cleared_by?.kind === "manual",
    ruleStep: o.rule ? { rule: String(o.rule), step: Number(o.step), steps: Number(o.steps) } : null,
  }));

  return {
    nextActor: row.next_actor ?? null,
    version: row.version ?? 1,
    foldedAt: row.folded_at ?? null,
    pendingQuestions: (Array.isArray(row.pending_customer_inputs) ? row.pending_customer_inputs : []).map(
      (key: string) => ({ key, label: MISSING_FIELD_LABELS[key as MissingField] ?? key })
    ),
    obligations,
  };
}

/**
 * A person marks one open check done or cancelled. Refused unless the check is
 * pending on this ticket, so a stale page cannot settle a check twice or one
 * that belongs elsewhere.
 */
export async function actOnObligation(
  shopId: string,
  ticketId: string,
  obligationId: string,
  action: string,
  actedBy: string | null
): Promise<TicketCaseState | null> {
  if (!ACTIONS.has(action)) {
    throw new KnowledgeValidationError("action must be fulfilled or cancelled.");
  }
  const current = await getCaseState(shopId, ticketId);
  const target = current?.obligations.find((o) => o.id === obligationId);
  if (!target) throw new KnowledgeNotFoundError(`No check ${obligationId} on this ticket.`);
  if (target.status !== "pending") {
    throw new KnowledgeValidationError("This check is already settled.");
  }

  const supabase = getSupabaseClient();
  await supabaseInsert(supabase, T.TICKET_CASE_ACTIONS, [
    { shop_id: shopId, ticket_id: ticketId, obligation_id: obligationId, action, acted_by: actedBy },
  ]);

  await refoldTicket(shopId, ticketId);
  return getCaseState(shopId, ticketId);
}

/**
 * Re-folds one ticket now, with the agent's fold and the agent's actor map, so
 * the page shows the result of a person's action without waiting for the
 * worker's next poll. A raised version stales the drafts written before it.
 */
export async function refoldTicket(shopId: string, ticketId: string): Promise<{ versionsRaised: number; draftsStaled: number }> {
  const supabase = getSupabaseClient();
  // Loosely typed: TypeScript reads these JS signatures off their `null`
  // defaults and would refuse a real list or directory.
  const fold = runFold as unknown as (args: Record<string, unknown>) => Promise<{ versionsRaised: number; draftsStaled: number }>;
  const actor = actorOf as unknown as (...args: unknown[]) => string;
  const config = loadAgentConfig();
  const directory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });
  return fold({
    store: createCaseCurrentStore(supabase, { shopId }),
    shopId,
    ticketIds: [ticketId],
    actorFor: (message: unknown) => actor(message, directory, config.actorByLabel),
    // The ticket's status follows, as in the worker (stage 5c): settling the
    // last check a colleague owed moves it off awaiting_human.
    statusMap: config.caseStatusByNextActor,
    keepOpenLevels: [...AUTO_CLOSE_EXEMPT_LEVELS],
  });
}
