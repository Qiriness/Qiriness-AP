/**
 * Server-only reader and writer for `support_parameters`.
 *
 * THE CATALOGUE IS CODE, THE VALUES ARE DATA. Which parameters exist, what each
 * one means and how it is parsed live in `scripts/lib/parameters.mjs`; only the
 * numbers live in the table. A screen that let somebody invent a key would let
 * them spend an afternoon setting something nothing reads.
 *
 * A ROW IS CREATED ON DEMAND. The catalogue is the list; a missing row simply
 * means nobody has set that one yet, and saving creates it. That way adding a
 * parameter to the codebase needs no migration and no backfill — it appears on
 * the screen, unset, the moment code knows about it.
 *
 * Uses the SERVICE ROLE key. Never import from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { PARAMETERS } from "../../../scripts/lib/parameters.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { SupportParameter } from "../types";

const TABLE = "support_parameters";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

export async function getShopId(): Promise<string> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = await supabaseSelect(getSupabaseClient(), "shops", { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(`No shop record found for ${config.shopDomain}.`);
  }
  return id;
}

/**
 * Every parameter the codebase knows about, with its value where one is set.
 *
 * DRIVEN BY THE CATALOGUE, NOT BY THE TABLE. Listing rows would hide a parameter
 * nobody has set yet — which is exactly the one somebody needs to see, because an
 * unset parameter is a decision outstanding rather than a setting missing.
 */
export async function listParameters(shopId: string): Promise<SupportParameter[]> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId },
    "parameter_key,value,kind,updated_at",
  )) as Record<string, unknown>[];

  const byKey = new Map(rows.map((row) => [String(row.parameter_key), row]));

  return Object.entries(PARAMETERS).map(([key, meta]) => {
    const row = byKey.get(key);
    const definition = meta as { kind: string; label: string; description: string; usedBy: string };
    return {
      key,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      usedBy: definition.usedBy,
      value: (row?.value as string) ?? null,
      updatedAt: (row?.updated_at as string) ?? null,
    };
  });
}

/**
 * Sets one parameter, or clears it.
 *
 * CLEARING IS A REAL OPERATION, not a validation failure. "We have not decided
 * this yet" is a state every reader already handles, and taking a wrong number
 * out of circulation must not require inventing a right one first.
 */
export async function setParameter(
  shopId: string,
  key: string,
  value: string | null,
): Promise<SupportParameter> {
  const definition = (PARAMETERS as Record<string, { kind: string } | undefined>)[key];
  if (!definition) {
    throw new KnowledgeNotFoundError(`No parameter called “${key}”.`);
  }

  const trimmed = value === null ? null : String(value).trim();
  const stored = trimmed === "" ? null : trimmed;

  // Mirrors the check constraint so a bad value is a sentence rather than a
  // Postgres error string. The constraint still stands behind this.
  if (stored !== null) {
    if (definition.kind === "days" && !/^[0-9]+$/.test(stored)) {
      throw new KnowledgeValidationError("A number of days must be a whole number, like 30.");
    }
    if (definition.kind === "amount" && !/^[0-9]+(\.[0-9]{1,2})?$/.test(stored)) {
      throw new KnowledgeValidationError("An amount must be a number, like 70 or 70.00.");
    }
  }

  await supabaseUpsert(
    getSupabaseClient(),
    TABLE,
    [
      {
        shop_id: shopId,
        parameter_key: key,
        value: stored,
        kind: definition.kind,
        label: (PARAMETERS as Record<string, { label: string }>)[key].label,
        description: (PARAMETERS as Record<string, { description: string }>)[key].description,
      },
    ],
    "shop_id,parameter_key",
  );

  const all = await listParameters(shopId);
  return all.find((p) => p.key === key)!;
}
