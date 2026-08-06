/**
 * Case file -> the three blocks the expanded ticket row shows.
 *
 * Pure, like `ticket-stats.ts`: a stored `ticket_investigations` row goes in, a
 * `TicketResults` comes out. No I/O, no clock.
 *
 * WHY THE SUMMARY IS DERIVED RATHER THAN STORED. There is no summary column and
 * there deliberately is not one: a model asked for a prose summary *beside* the
 * evidence lists writes a fourth account of the ticket that can disagree with
 * all three — exactly the failure `do_not_claim` and the derived `replyIntent`
 * exist to prevent. What the agent established IS the result, so the summary is
 * the verified `established` claims and a headline read off the verdict.
 *
 * THE ACTION SENTENCE IS LOOKED UP, NOT COMPOSED, for the same reason
 * `MISSING_FIELDS` owns the question put to a customer. Only one branch shows
 * model prose — `handoff.action`, which is the model's whole job on a
 * `needs_human` verdict and is internal by construction.
 */

import type {
  InvestigationVerdict,
  MissingField,
  TicketResults,
} from "./types";
import { MISSING_FIELD_LABELS } from "./types";

/** The slice of a `ticket_investigations` row this projection needs. */
export interface InvestigationRecord {
  verdict: InvestigationVerdict;
  established: { claim?: string | null }[];
  missing: { field?: string | null }[];
  handoff: { action?: string | null; why?: string | null } | null;
  investigatedAt: string | null;
}

/** Where the investigation got to, in one line. */
const HEADLINES: Record<InvestigationVerdict, string> = {
  answerable: "The agent found enough to answer this.",
  needs_customer_input: "The agent needs something from the customer first.",
  needs_human: "The agent could not settle this on its own.",
};

/** The fallback action per verdict, used when nothing more specific applies. */
const DEFAULT_ACTIONS: Record<InvestigationVerdict, string> = {
  answerable: "Reply to the customer using the results above.",
  // buildCaseFile downgrades a needs_customer_input verdict that names nothing
  // to ask for, so this line should be unreachable — it is here so a case file
  // written by an older pass still renders an action rather than an empty block.
  needs_customer_input: "Ask the customer for the missing details.",
  needs_human: "Read the thread and handle it by hand.",
};

export function summariseInvestigation(record: InvestigationRecord): TicketResults {
  const verdict = record.verdict;
  const findings = (record.established ?? [])
    .map((entry) => String(entry?.claim ?? "").trim())
    .filter(Boolean);

  return {
    verdict,
    headline: HEADLINES[verdict] ?? HEADLINES.needs_human,
    findings,
    action: deriveAction(verdict, record),
    // The reason belongs to the handoff, so it is shown only where the handoff
    // is: pairing it with "reply to the customer" would read as an instruction.
    actionReason:
      verdict === "needs_human" ? nonEmpty(record.handoff?.why) : null,
    investigatedAt: record.investigatedAt,
  };
}

function deriveAction(verdict: InvestigationVerdict, record: InvestigationRecord): string {
  if (verdict === "needs_customer_input") {
    const wanted = (record.missing ?? [])
      .map((entry) => entry?.field)
      .filter((field): field is MissingField => Boolean(field && field in MISSING_FIELD_LABELS))
      .map((field) => MISSING_FIELD_LABELS[field]);

    if (wanted.length > 0) {
      return `Ask the customer for ${joinList(wanted)}.`;
    }
  }

  if (verdict === "needs_human") {
    // The one place model prose reaches this panel. It is internal by
    // construction — `toDraftingPrompt` omits the handoff entirely.
    const action = nonEmpty(record.handoff?.action);
    if (action) {
      return action;
    }
  }

  return DEFAULT_ACTIONS[verdict] ?? DEFAULT_ACTIONS.needs_human;
}

/** "a", "a and b", "a, b and c" — no Oxford comma; the dashboard is British. */
function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
