/**
 * Server-only forwarding configuration for the Agent Setup dashboard.
 *
 * Reads and writes `forwarding_destinations` (who receives mail the contact
 * team does not own, and what they handle) and `forwarding_settings` (the
 * shop-wide acknowledgement). The worker reads the same tables; this module
 * owns only the editing side.
 *
 * Validation is `scripts/lib/forwarding-destinations.mjs`, shared with the
 * worker, so the page cannot save a destination the router would refuse.
 *
 * Uses the Supabase SERVICE ROLE key for the same reason knowledge-service does:
 * every table has RLS enabled with no policies, so only the service role can
 * read or write. Never import this from a client component.
 */

import { cache } from "react";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdate,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import {
  DEFAULT_ACK_TEMPLATES,
  normaliseAckSettings,
  normaliseDestination,
} from "../../../scripts/lib/forwarding-destinations.mjs";
import { forwardingTag } from "../../../scripts/lib/forwarding-tag.mjs";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type {
  ForwardingAckSettings,
  ForwardingConfig,
  ForwardingDestination,
  ForwardingDestinationInput,
  ForwardTiming,
  KnowledgeCategory,
  RequestKind,
  TicketForwarding,
} from "../types";

const DESTINATION_COLUMNS =
  "id,label,forward_email,description,categories,request_kinds,match_description,timing,acknowledge," +
  "public_name_fr,public_name_en,ack_note_fr,ack_note_en,position,active_since";

interface DestinationRow {
  id: string;
  label: string;
  forward_email: string | null;
  description: string | null;
  categories: string[] | null;
  request_kinds: string[] | null;
  match_description: boolean;
  timing: string;
  acknowledge: boolean;
  public_name_fr: string | null;
  public_name_en: string | null;
  ack_note_fr: string | null;
  ack_note_en: string | null;
  position: number | null;
  active_since: string | null;
}

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env));
}

/** Destinations in page order, the acknowledgement settings and the defaults they fall back to. */
export async function getForwardingConfig(shopId: string, shopName: string | null): Promise<ForwardingConfig> {
  const supabase = getSupabaseClient();
  const [rows, settingsRows] = await Promise.all([
    supabaseSelectAll(supabase, T.FORWARDING_DESTINATIONS, { shop_id: shopId }, DESTINATION_COLUMNS, {
      order: "position.asc,created_at.asc",
    }) as Promise<DestinationRow[]>,
    // One row per shop, keyed on shop_id: a plain select. `supabaseSelectAll`
    // pages by ordering on `id`, which this table does not have.
    supabaseSelect(
      supabase,
      T.FORWARDING_SETTINGS,
      { shop_id: shopId },
      "ack_enabled,ack_template_fr,ack_template_en,forward_since"
    ) as Promise<
      { ack_enabled: boolean; ack_template_fr: string | null; ack_template_en: string | null; forward_since: string | null }[]
    >,
  ]);

  const settings = settingsRows[0];
  return {
    destinations: rows.map(toDestination),
    settings: {
      ackEnabled: settings?.ack_enabled ?? false,
      ackTemplateFr: settings?.ack_template_fr ?? null,
      ackTemplateEn: settings?.ack_template_en ?? null,
    },
    forwardSince: settings?.forward_since ?? null,
    defaultTemplates: { fr: DEFAULT_ACK_TEMPLATES.fr, en: DEFAULT_ACK_TEMPLATES.en },
    shopName: shopName ?? "",
  };
}

export async function createDestination(
  shopId: string,
  input: ForwardingDestinationInput
): Promise<ForwardingDestination> {
  const value = validated(input);
  const supabase = getSupabaseClient();
  const rows = (await withLabelCheck(() =>
    supabaseInsert(supabase, T.FORWARDING_DESTINATIONS, [{ shop_id: shopId, ...value }])
  )) as DestinationRow[];
  return toDestination(rows[0]);
}

/**
 * Replaces one destination's form fields. Scoped to the shop, so an id from
 * elsewhere matches nothing. The switch is left alone — except that removing
 * the address switches it off, since there is nowhere left to send.
 */
export async function updateDestination(
  shopId: string,
  id: string,
  input: ForwardingDestinationInput
): Promise<ForwardingDestination> {
  const value = validated(input);
  const patch = value.forward_email ? value : { ...value, active_since: null };
  const supabase = getSupabaseClient();
  const rows = (await withLabelCheck(() =>
    supabaseUpdate(supabase, T.FORWARDING_DESTINATIONS, { id, shop_id: shopId }, patch, {
      select: DESTINATION_COLUMNS,
    })
  )) as DestinationRow[];
  if (!rows?.[0]) {
    throw new KnowledgeNotFoundError("That destination no longer exists.");
  }
  return toDestination(rows[0]);
}

/**
 * One destination's switch. On keeps the moment it was already on, or starts
 * from now; off clears it. It receives only mail received after that moment,
 * so switching it back on never delivers what arrived while it was off.
 * A new destination starts off.
 */
export async function setDestinationOn(shopId: string, id: string, on: boolean): Promise<ForwardingDestination> {
  const supabase = getSupabaseClient();
  const [current] = (await supabaseSelect(
    supabase,
    T.FORWARDING_DESTINATIONS,
    { id, shop_id: shopId },
    "forward_email,active_since"
  )) as { forward_email: string | null; active_since: string | null }[];
  if (!current) {
    throw new KnowledgeNotFoundError("That destination no longer exists.");
  }
  if (on && !current.forward_email) {
    throw new KnowledgeValidationError("Give the destination an address before switching it on.");
  }
  const activeSince = on ? current.active_since ?? new Date().toISOString() : null;
  const rows = (await supabaseUpdate(
    supabase,
    T.FORWARDING_DESTINATIONS,
    { id, shop_id: shopId },
    { active_since: activeSince },
    { select: DESTINATION_COLUMNS }
  )) as DestinationRow[];
  return toDestination(rows[0]);
}

/**
 * Deleting only stops future forwards: `ticket_forwards` snapshots the address
 * each forward went to, so the record of what was sent is unaffected.
 */
export async function deleteDestination(shopId: string, id: string): Promise<void> {
  await supabaseDelete(getSupabaseClient(), T.FORWARDING_DESTINATIONS, { id, shop_id: shopId });
}

export async function saveAckSettings(
  shopId: string,
  input: ForwardingAckSettings
): Promise<ForwardingAckSettings> {
  const result = normaliseAckSettings(input);
  if ("error" in result) {
    throw new KnowledgeValidationError(result.error);
  }
  const rows = (await supabaseUpsert(
    getSupabaseClient(),
    T.FORWARDING_SETTINGS,
    [{ shop_id: shopId, ...result.value }],
    "shop_id"
  )) as { ack_enabled: boolean; ack_template_fr: string | null; ack_template_en: string | null }[];
  const row = rows[0];
  return {
    ackEnabled: row.ack_enabled,
    ackTemplateFr: row.ack_template_fr,
    ackTemplateEn: row.ack_template_en,
  };
}

/**
 * The master switch. On keeps an existing start date (switching on twice must
 * not move it), or starts from now; off clears it. From that instant only mail
 * RECEIVED afterwards is forwarded, so turning it on never sends the backlog.
 */
export async function setForwardingOn(shopId: string, on: boolean): Promise<string | null> {
  const supabase = getSupabaseClient();
  const [current] = (await supabaseSelect(supabase, T.FORWARDING_SETTINGS, { shop_id: shopId }, "forward_since")) as {
    forward_since: string | null;
  }[];
  const forwardSince = on ? current?.forward_since ?? new Date().toISOString() : null;
  const rows = (await supabaseUpsert(
    supabase,
    T.FORWARDING_SETTINGS,
    [{ shop_id: shopId, forward_since: forwardSince }],
    "shop_id"
  )) as { forward_since: string | null }[];
  return rows[0]?.forward_since ?? null;
}

function validated(input: ForwardingDestinationInput) {
  const result = normaliseDestination(input);
  if ("error" in result) {
    throw new KnowledgeValidationError(result.error);
  }
  return result.value;
}

/** Two destinations with one name would be indistinguishable on the page and in the ledger. */
async function withLabelCheck<R>(write: () => Promise<R>): Promise<R> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Error && error.message.includes("forwarding_destinations_label_unique")) {
      throw new KnowledgeValidationError("Another destination already has that name.");
    }
    throw error;
  }
}

function toDestination(row: DestinationRow): ForwardingDestination {
  return {
    id: row.id,
    label: row.label,
    forwardEmail: row.forward_email,
    description: row.description ?? "",
    categories: (row.categories ?? []) as KnowledgeCategory[],
    requestKinds: (row.request_kinds ?? []) as RequestKind[],
    matchDescription: row.match_description,
    timing: row.timing as ForwardTiming,
    acknowledge: row.acknowledge,
    publicNameFr: row.public_name_fr,
    publicNameEn: row.public_name_en,
    ackNoteFr: row.ack_note_fr,
    ackNoteEn: row.ack_note_en,
    position: row.position ?? 0,
    activeSince: row.active_since,
  };
}

/** Answers « is this ticket being handed to a colleague? » for one queue row. */
export type ForwardingFacts = (ticketId: string, category: string | null) => TicketForwarding | null;

export const NO_FORWARDING: ForwardingFacts = () => null;

/**
 * The forwarding tag for every ticket in the shop, read once per request: the
 * switch, the destinations, the router's decisions and the attempts — four small
 * reads whatever the list size. The tag itself is `forwardingTag`
 * (scripts/lib/forwarding-tag.mjs), which only reports what the pass decided or did.
 */
export const readForwardingFacts = cache(async (shopId: string): Promise<ForwardingFacts> => {
  const supabase = getSupabaseClient();
  const [settings, destinations, routing, forwards] = (await Promise.all([
    supabaseSelect(supabase, T.FORWARDING_SETTINGS, { shop_id: shopId }, "forward_since"),
    supabaseSelectAll(supabase, T.FORWARDING_DESTINATIONS, { shop_id: shopId }, DESTINATION_COLUMNS),
    supabaseSelectAll(
      supabase,
      T.TICKET_ROUTING,
      { shop_id: shopId, outcome: "forward" },
      "ticket_id,outcome,category,destination_id,destination_label"
    ),
    supabaseSelectAll(supabase, T.TICKET_FORWARDS, { shop_id: shopId }, "ticket_id,status,destination_label,created_at"),
  ])) as [{ forward_since: string | null }[] | null, DestinationRow[], any[], any[]];

  const switchedOn = Boolean(settings?.[0]?.forward_since);
  const routingByTicket = new Map(routing.map((row) => [row.ticket_id, row]));
  const forwardsByTicket = new Map<string, any[]>();
  for (const row of forwards) {
    forwardsByTicket.set(row.ticket_id, [...(forwardsByTicket.get(row.ticket_id) ?? []), row]);
  }
  const destinationById = new Map(destinations.map((row) => [row.id, row]));

  return (ticketId, category) => {
    const route = routingByTicket.get(ticketId) ?? null;
    const attempts = forwardsByTicket.get(ticketId) ?? [];
    if (!route && attempts.length === 0) return null;
    return forwardingTag({
      ticketCategory: category,
      routing: route,
      forwards: attempts,
      destination: route?.destination_id ? destinationById.get(route.destination_id) ?? null : null,
      switchedOn,
    }) as TicketForwarding | null;
  };
});
