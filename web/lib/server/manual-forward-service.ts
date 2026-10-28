/**
 * A person forwarding a ticket's whole thread to colleagues
 * (06_manual_forwards.sql). The page sends who and a note; this checks that
 * every recipient is internal, records the forward and queues it. The worker
 * builds and sends the mail (agent/src/outbound/forward-ticket.mjs): nothing
 * is sent from here.
 *
 * WHO CAN RECEIVE ONE: a team member (`dashboard_team()`), a forwarding
 * destination configured in Agent Setup, or an address on one of our own
 * domains. Anything else is refused: a forward is always internal, which is
 * what lets its Sent Items copy be read as « not an answer to the customer ».
 *
 * Server-only: it uses the service role. Never import from a client component.
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { createMailJobRecord } from "../../../scripts/lib/mail-job-record.mjs";
import { createManualForwardRecord, forwardDedupeKey } from "../../../scripts/lib/manual-forward-record.mjs";
import { isInternalSender, resolveInternalDomains } from "../../../scripts/lib/message-audience.mjs";
import { loadAgentConfig } from "../../../agent/src/config.mjs";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import { listTeam, teamAddress } from "./team-service";
import type { CurrentUser } from "./auth";
import type { ForwardRecipientOption, TicketForward } from "../types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const FORWARD_NOTE_MAX = 5000;
const MAX_RECIPIENTS = 10;

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

function internalDomains(): string[] {
  const config = loadAgentConfig();
  // Loosely typed: TypeScript reads the JS signature off its default and would refuse the mailbox.
  const resolve = resolveInternalDomains as unknown as (args: { supportMailbox: string | undefined; extra: string[] }) => string[];
  return resolve({ supportMailbox: config.graph.mailbox, extra: config.internalEmailDomains ?? [] });
}

type DestinationRow = { id: string; label: string; forward_email: string | null };

async function readDestinations(shopId: string): Promise<DestinationRow[]> {
  const rows = (await supabaseSelect(getSupabaseClient(), T.FORWARDING_DESTINATIONS, { shop_id: shopId }, "id,label,forward_email", {
    order: "position.asc",
  })) as DestinationRow[];
  return rows.filter((row) => row.forward_email);
}

/**
 * What the picker offers: the team by name, then the destinations by label.
 * A destination on an outside domain is left out: a forward is always internal.
 */
export async function listForwardRecipients(shopId: string): Promise<ForwardRecipientOption[]> {
  const domains = internalDomains();
  const [team, destinations] = await Promise.all([listTeam(), readDestinations(shopId)]);
  return [
    ...team.map((member) => ({ key: `team:${member.id}`, name: member.name, kind: "team" as const })),
    ...destinations
      .filter((row) => isInternalSender(row.forward_email, domains))
      .map((row) => ({ key: `destination:${row.id}`, name: row.label, kind: "destination" as const })),
  ];
}

type Recipient = { email: string; name: string; kind: "team" | "destination" | "address" };

/** Each picked key or typed address, resolved and checked internal. Refuses the whole list on one bad entry. */
async function resolveRecipients(shopId: string, picked: string[]): Promise<Recipient[]> {
  const domains = internalDomains();
  const destinations = picked.some((key) => key.startsWith("destination:")) ? await readDestinations(shopId) : [];
  const out: Recipient[] = [];
  for (const raw of picked) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    let recipient: Recipient | null = null;
    if (value.startsWith("team:")) {
      const member = await teamAddress(value.slice(5));
      if (!member) throw new KnowledgeValidationError("That person cannot receive forwards: their account is not active.");
      recipient = { email: member.email, name: member.name, kind: "team" };
    } else if (value.startsWith("destination:")) {
      const row = destinations.find((d) => d.id === value.slice(12));
      if (!row?.forward_email) throw new KnowledgeValidationError("That forwarding destination no longer exists.");
      recipient = { email: row.forward_email.toLowerCase(), name: row.label, kind: "destination" };
    } else {
      if (!EMAIL.test(value)) throw new KnowledgeValidationError(`« ${value} » is not an email address.`);
      recipient = { email: value.toLowerCase(), name: value.toLowerCase(), kind: "address" };
    }
    if (!isInternalSender(recipient.email, domains)) {
      throw new KnowledgeValidationError(`« ${recipient.name} » is outside the company. A ticket can only be forwarded to colleagues.`);
    }
    if (!out.some((r) => r.email === recipient!.email)) out.push(recipient);
  }
  if (out.length === 0) throw new KnowledgeValidationError("Choose who to forward the ticket to.");
  if (out.length > MAX_RECIPIENTS) throw new KnowledgeValidationError(`A forward can go to ${MAX_RECIPIENTS} people at most.`);
  return out;
}

function mapForward(row: any): TicketForward {
  return {
    id: row.id,
    recipients: (Array.isArray(row.recipients) ? row.recipients : []).map((r: any) => ({
      name: String(r?.name ?? r?.email ?? "—"),
      kind: r?.kind === "team" || r?.kind === "destination" ? r.kind : "address",
    })),
    note: row.note ?? null,
    forwardedByName: row.forwarded_by_name ?? null,
    state: row.state,
    error: row.error ?? null,
    attachmentsSent: Number(row.attachments_sent ?? 0),
    attachmentsSkipped: (Array.isArray(row.attachments_skipped) ? row.attachments_skipped : []).map((f: any) => ({
      name: f?.name ?? null,
      reason: String(f?.reason ?? "too_large"),
    })),
    sentAt: row.sent_at ?? null,
    createdAt: row.created_at,
  };
}

/** A ticket's forwards, and each one's Message-ID so the thread can place its sent copy inside it. */
export async function readForwards(shopId: string, ticketId: string): Promise<{ forwards: TicketForward[]; byMessageId: Map<string, string> }> {
  const rows = (await createManualForwardRecord(getSupabaseClient(), { shopId }).forTicket(ticketId)) as any[];
  const byMessageId = new Map<string, string>();
  for (const row of rows) if (row.internet_message_id) byMessageId.set(row.internet_message_id, row.id);
  return { forwards: rows.map(mapForward), byMessageId };
}

export async function forwardTicket(
  shopId: string,
  ticketId: string,
  request: { recipients: unknown; note: unknown; clientKey: unknown },
  session: CurrentUser | null
): Promise<TicketForward> {
  if (process.env.OUTBOUND_SEND_ENABLED !== "true") {
    throw new KnowledgeValidationError("Sending is switched off on this server, so nothing can be forwarded from here.");
  }
  const clientKey = String(request.clientKey ?? "");
  if (!UUID.test(clientKey)) throw new KnowledgeValidationError("This forward has no key: reload the page and try again.");
  const note = typeof request.note === "string" ? request.note.trim() : "";
  if (note.length > FORWARD_NOTE_MAX) throw new KnowledgeValidationError(`The note can be ${FORWARD_NOTE_MAX} characters at most.`);
  const picked = Array.isArray(request.recipients) ? request.recipients.map(String) : [];

  const supabase = getSupabaseClient();
  const tickets = await supabaseSelect(supabase, T.TICKETS, { id: ticketId, shop_id: shopId }, "id,deleted_at", { limit: 1 });
  if (!tickets[0] || tickets[0].deleted_at) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);

  const recipients = await resolveRecipients(shopId, picked);
  const { created, forward } = await createManualForwardRecord(supabase, { shopId }).create({
    ticket_id: ticketId,
    client_key: clientKey,
    recipients,
    note: note || null,
    forwarded_by: session?.sub ?? null,
    forwarded_by_name: session?.displayName?.trim() || session?.email?.split("@")[0] || null,
  });
  if (created) {
    await createMailJobRecord(supabase, { shopId }).enqueue({
      kind: "send_outbound",
      dedupeKey: forwardDedupeKey(forward.id),
      payload: { manualForwardId: forward.id },
    });
  }
  return mapForward(forward);
}

/** « Retry » on a failed forward: back in the queue, a fresh draft. */
export async function retryForward(shopId: string, forwardId: string): Promise<TicketForward> {
  const supabase = getSupabaseClient();
  const forward = await createManualForwardRecord(supabase, { shopId }).retry(forwardId);
  if (!forward) throw new KnowledgeValidationError("Only a forward that failed can be retried.");
  await createMailJobRecord(supabase, { shopId }).enqueue({
    kind: "send_outbound",
    dedupeKey: `${forwardDedupeKey(forward.id)}:${Date.now()}`,
    payload: { manualForwardId: forward.id },
  });
  return mapForward(forward);
}
