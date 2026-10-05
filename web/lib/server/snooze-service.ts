/**
 * Snooze on the ticket page: what is snoozed, and a person snoozing or waking
 * a ticket. Every write goes through scripts/lib/snooze-record.mjs, the one
 * writer of `ticket_snoozes`, shared with the worker (the fold snoozes after a
 * sent reply; ingestion and the deadline sweep wake). DECISIONS.md § Snooze.
 *
 * Server-only: it uses the service role. Never import from a client component.
 */
import { cache } from "react";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { days, toParameterMap } from "../../../scripts/lib/parameters.mjs";
import {
  CLOSED_TICKET_STATUSES,
  FALLBACK_PARAMETER,
  WAITING_FOR,
  createSnoozeRecord,
  fallbackWakeAt,
  snoozeRow,
} from "../../../scripts/lib/snooze-record.mjs";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { SnoozeRequest, SnoozeWaitingFor, SnoozeWakeReason, TicketSnooze, TicketWake } from "../types";
import type { SnoozeDelays } from "../snooze";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/** How long a ticket that just came back stays marked in the list. */
const RECENT_WAKE_MS = 24 * 60 * 60 * 1000;

export interface SnoozeFacts {
  snooze: TicketSnooze | null;
  lastWake: TicketWake | null;
}

export const NO_SNOOZE: SnoozeFacts = { snooze: null, lastWake: null };

type SnoozeRowShape = {
  id: string;
  ticket_id: string;
  source: "auto" | "manual";
  waiting_for: SnoozeWaitingFor;
  reason: string | null;
  wake_at: string;
  snoozed_at: string;
  woke_at: string | null;
  wake_reason: SnoozeWakeReason | null;
};

export function mapSnooze(row: SnoozeRowShape): TicketSnooze {
  return {
    id: row.id,
    source: row.source,
    waitingFor: row.waiting_for,
    // The agent's code (`after_our_reply`) is not a note for a person to read.
    reason: row.source === "manual" ? row.reason : null,
    wakeAt: row.wake_at,
    snoozedAt: row.snoozed_at,
  };
}

/**
 * The open snooze and the last recent wake of every ticket in the shop, read
 * once per request: two small reads of `ticket_snoozes`, whatever the list size.
 */
export const readSnoozeFacts = cache(async (shopId: string): Promise<Map<string, SnoozeFacts>> => {
  const record = createSnoozeRecord(getSupabaseClient(), { shopId });
  const [open, woken] = (await Promise.all([
    record.allOpen(),
    record.wokenSince(new Date(Date.now() - RECENT_WAKE_MS)),
  ])) as [SnoozeRowShape[], SnoozeRowShape[]];
  const facts = new Map<string, SnoozeFacts>();
  // Newest first, so the first wake seen per ticket is its latest.
  for (const row of woken) {
    if (facts.has(row.ticket_id) || !row.woke_at || !row.wake_reason) continue;
    facts.set(row.ticket_id, { snooze: null, lastWake: { reason: row.wake_reason, at: row.woke_at } });
  }
  for (const row of open) {
    facts.set(row.ticket_id, { snooze: mapSnooze(row), lastWake: facts.get(row.ticket_id)?.lastWake ?? null });
  }
  return facts;
});

async function parameterMap(shopId: string) {
  return toParameterMap(
    await supabaseSelect(getSupabaseClient(), T.SUPPORT_PARAMETERS, { shop_id: shopId }, "parameter_key,value")
  );
}

export async function readSnoozeDelays(shopId: string): Promise<SnoozeDelays> {
  const map = await parameterMap(shopId);
  return {
    customer: days(map, FALLBACK_PARAMETER.customer),
    colleague: days(map, FALLBACK_PARAMETER.colleague),
    partner: days(map, FALLBACK_PARAMETER.partner),
  };
}

const REFUSALS: Record<string, string> = {
  no_wake_at: "Choose when the ticket should come back.",
  wake_in_past: "That time has already passed.",
  too_far: "A ticket can be snoozed for 60 days at most.",
  bad_waiting_for: "Snooze until a time, the customer, a colleague or an operations partner.",
};

/**
 * A person snoozes a ticket. Waiting for a party without a time takes the
 * shop's delay for that party as the deadline: every snooze has one.
 */
export async function snoozeTicket(
  shopId: string,
  ticketId: string,
  request: SnoozeRequest,
  snoozedBy: string | null
): Promise<TicketSnooze> {
  const supabase = getSupabaseClient();
  const waitingFor = request.waitingFor;
  if (!(WAITING_FOR as readonly string[]).includes(waitingFor)) {
    throw new KnowledgeValidationError(REFUSALS.bad_waiting_for);
  }
  const tickets = await supabaseSelect(supabase, T.TICKETS, { id: ticketId, shop_id: shopId }, "id,status,deleted_at", { limit: 1 });
  if (!tickets[0] || tickets[0].deleted_at) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  // Closure takes precedence: a finished ticket is not waiting for anything.
  if ((CLOSED_TICKET_STATUSES as readonly string[]).includes(tickets[0].status)) {
    throw new KnowledgeValidationError("This ticket is closed. Reopen it before snoozing it.");
  }

  const now = new Date();
  let wakeAt: Date | string | null = request.until ?? null;
  if (!wakeAt && waitingFor !== "date") {
    wakeAt = fallbackWakeAt({ waitingFor, from: now, parameters: await parameterMap(shopId) });
    if (!wakeAt) {
      throw new KnowledgeValidationError(
        `No delay is set for this in Agent Setup (${FALLBACK_PARAMETER[waitingFor]}). Pick a date instead.`
      );
    }
  }

  const { row, error } = snoozeRow({
    ticketId,
    source: "manual",
    waitingFor,
    wakeAt,
    reason: request.reason ?? null,
    snoozedBy,
    now,
  });
  if (!row) throw new KnowledgeValidationError(REFUSALS[error ?? ""] ?? `Cannot snooze: ${error}.`);

  const record = createSnoozeRecord(supabase, { shopId });
  const { created, snooze } = await record.snooze(row);
  if (!created) {
    throw new KnowledgeValidationError("This ticket is already snoozed. Wake it first to change the snooze.");
  }
  return mapSnooze(snooze as SnoozeRowShape);
}

/**
 * A ticket was closed or resolved: its snooze ends, as `resolved`. CLOSURE
 * TAKES PRECEDENCE OVER A SNOOZE, so the ticket neither comes back at the
 * deadline nor hides again if someone reopens it (snooze-record.mjs).
 */
export async function endSnoozeOnClose(shopId: string, ticketId: string, closedBy: string | null): Promise<void> {
  const record = createSnoozeRecord(getSupabaseClient(), { shopId });
  await record.wake(ticketId, "resolved", { wokenBy: closedBy });
}

/** A person wakes a ticket now. Returns the wake, or null when it was not snoozed. */
export async function unsnoozeTicket(shopId: string, ticketId: string, wokenBy: string | null): Promise<TicketWake | null> {
  const record = createSnoozeRecord(getSupabaseClient(), { shopId });
  const row = (await record.wake(ticketId, "manual", { wokenBy })) as SnoozeRowShape | null;
  return row?.woke_at ? { reason: "manual", at: row.woke_at } : null;
}
