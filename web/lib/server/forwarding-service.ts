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

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseInsert,
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
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type {
  ForwardingAckSettings,
  ForwardingConfig,
  ForwardingDestination,
  ForwardingDestinationInput,
  ForwardTiming,
  KnowledgeCategory,
  RequestKind,
} from "../types";

const DESTINATION_COLUMNS =
  "id,label,forward_email,description,categories,request_kinds,match_description,timing,acknowledge," +
  "public_name_fr,public_name_en,ack_note_fr,ack_note_en,position";

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
    supabaseSelectAll(
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

/** Replaces one destination whole. Scoped to the shop, so an id from elsewhere matches nothing. */
export async function updateDestination(
  shopId: string,
  id: string,
  input: ForwardingDestinationInput
): Promise<ForwardingDestination> {
  const value = validated(input);
  const supabase = getSupabaseClient();
  const rows = (await withLabelCheck(() =>
    supabaseUpdate(supabase, T.FORWARDING_DESTINATIONS, { id, shop_id: shopId }, value, {
      select: DESTINATION_COLUMNS,
    })
  )) as DestinationRow[];
  if (!rows?.[0]) {
    throw new KnowledgeNotFoundError("That destination no longer exists.");
  }
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
  const [current] = (await supabaseSelectAll(supabase, T.FORWARDING_SETTINGS, { shop_id: shopId }, "forward_since")) as {
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
  };
}
