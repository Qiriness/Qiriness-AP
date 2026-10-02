/**
 * The marketplaces the shop sells on (`sales_channels`): Setup -> Sales channels.
 *
 * Until 2026-10-02 they were constants naming this shop's two marketplaces, so
 * another shop would have had Amazon and Yves Rocher in its filters and its
 * sentences. A row is a name and the Shopify sales channel handles behind it;
 * every handle not listed is the shop's own store.
 *
 * THE SCREEN SHOWS WHAT THE ORDERS SAY, beside what is configured: every handle
 * the shop's orders carry, with Shopify's own label and an order count, and
 * which marketplace (if any) each one is in. A handle is not something a
 * merchant knows by heart; « connect-dev-1 » is Yves Rocher only because the
 * orders say so.
 *
 * Server-only (service role).
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseInsert,
  supabaseRpc,
  supabaseSelect,
  supabaseUpdateById,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { RPC, T } from "../../../scripts/lib/tables.mjs";
import { KnowledgeValidationError } from "./knowledge-errors";
import type { SalesChannelsView } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,40}$/;

export async function listSalesChannels(shopId: string): Promise<SalesChannelsView> {
  const supabase = getSupabaseClient();
  const [rows, observed] = await Promise.all([
    supabaseSelect(
      supabase,
      T.SALES_CHANNELS,
      { shop_id: shopId },
      "id,platform_key,label,handles,analytics_names,position",
      { order: "position.asc" }
    ),
    // Every order the shop holds, whatever its date: the widest window the
    // function accepts, in UTC.
    supabaseRpc(supabase, RPC.INSIGHTS_ORDERS_BY_CHANNEL, {
      p_shop: shopId,
      p_from: "2000-01-01T00:00:00",
      p_to: "2100-01-01T00:00:00",
      p_tz: "UTC",
    }).catch(() => []),
  ]);

  const channels = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: String(row.id),
    platformKey: String(row.platform_key),
    label: String(row.label),
    handles: (row.handles ?? []).map(String),
    analyticsNames: (row.analytics_names ?? []).map(String),
  }));
  const owner = new Map<string, string>();
  for (const channel of channels) for (const handle of channel.handles) owner.set(handle, channel.label);

  return {
    channels,
    observedHandles: (Array.isArray(observed) ? observed : [])
      .filter((row: any) => row.channel)
      .map((row: any) => ({
        handle: String(row.channel),
        shopifyLabel: (row.channel_label as string | null) ?? null,
        orders: Number(row.orders ?? 0),
        marketplace: owner.get(String(row.channel)) ?? null,
      }))
      .sort((a, b) => b.orders - a.orders),
  };
}

function list(value: unknown, lower = false): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(raw.map((v) => String(v).trim()).map((v) => (lower ? v.toLowerCase() : v)).filter(Boolean))];
}

function validLabel(value: unknown): string {
  const label = String(value ?? "").trim();
  if (!label) throw new KnowledgeValidationError("Give the marketplace a name.");
  return label;
}

/** `Yves Rocher` -> `yves_rocher`, unless the caller chose a key. */
function keyFor(input: any): string {
  const key = String(input.platformKey ?? input.label ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!KEY_SHAPE.test(key) || key === "all" || key === "shopify") {
    throw new KnowledgeValidationError("That name cannot be used as a marketplace key; choose another.");
  }
  return key;
}

/** A handle may belong to one marketplace only, or an order would be counted twice. */
async function assertHandlesFree(shopId: string, handles: string[], exceptId: string | null = null) {
  const view = await listSalesChannels(shopId);
  for (const channel of view.channels) {
    if (channel.id === exceptId) continue;
    const taken = channel.handles.filter((h) => handles.includes(h));
    if (taken.length > 0) {
      throw new KnowledgeValidationError(`${taken.join(", ")} already belongs to ${channel.label}.`);
    }
  }
}

export async function addSalesChannel(shopId: string, input: any): Promise<SalesChannelsView> {
  const label = validLabel(input.label);
  const handles = list(input.handles);
  await assertHandlesFree(shopId, handles);
  const existing = await listSalesChannels(shopId);
  await supabaseInsert(getSupabaseClient(), T.SALES_CHANNELS, [
    {
      shop_id: shopId,
      platform_key: keyFor({ ...input, label }),
      label,
      handles,
      analytics_names: list(input.analyticsNames, true),
      position: existing.channels.length,
    },
  ]);
  return listSalesChannels(shopId);
}

export async function updateSalesChannel(shopId: string, id: string, input: any): Promise<SalesChannelsView> {
  // The update is by id alone, so the row is checked to be this shop's first.
  if (!(await listSalesChannels(shopId)).channels.some((channel) => channel.id === id)) {
    throw new KnowledgeValidationError("No such marketplace.");
  }
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) patch.label = validLabel(input.label);
  if (input.handles !== undefined) {
    const handles = list(input.handles);
    await assertHandlesFree(shopId, handles, id);
    patch.handles = handles;
  }
  if (input.analyticsNames !== undefined) patch.analytics_names = list(input.analyticsNames, true);
  // The key never changes: it is in bookmarked Insights URLs.
  await supabaseUpdateById(getSupabaseClient(), T.SALES_CHANNELS, id, patch);
  return listSalesChannels(shopId);
}

export async function deleteSalesChannel(shopId: string, id: string): Promise<SalesChannelsView> {
  await supabaseDelete(getSupabaseClient(), T.SALES_CHANNELS, { id, shop_id: shopId });
  return listSalesChannels(shopId);
}
