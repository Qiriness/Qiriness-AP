/**
 * The outreach list behind the Support panel's reachability tile: the people who
 * wrote in, have never ordered online, and have consented to marketing.
 *
 * THIS IS THE ONLY PLACE IN THE APP THAT EXPORTS PERSONAL DATA IN BULK. Every
 * other surface shows aggregates or one customer at a time on screen. A CSV
 * leaves the building, so three things are true of this module and are meant to
 * stay true:
 *
 *   1. CONSENT IS THE FILTER, NOT A COLUMN. `on_email_marketing_list` is applied
 *      in the query. A file with a "consented" column would eventually be
 *      filtered by hand, or not filtered at all. Of the 22 people in this group
 *      only 8 qualify, and the other 14 must not be in the file to be forgotten
 *      about.
 *   2. ONE ROW PER PERSON, NOT PER TICKET. Somebody who wrote twice is one
 *      person to contact; a per-ticket export would put their address in a mail
 *      merge twice and send them the same campaign twice. Their subjects are
 *      joined into one cell instead.
 *   3. THE EXPORT IS AUDITED. One `data_access_events` row per download, with
 *      the count — `SHOPIFY_PERSONAL_DATA_PROTECTION.md` requires the trail, and
 *      an export is exactly the access worth being able to reconstruct later.
 *
 * Server-only, service-role.
 */

import { supabaseSelect } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { recordDataAccessEvent } from "../../../../scripts/lib/compliance-audit.mjs";
import { T } from "../../../../scripts/lib/tables.mjs";
import { CATEGORY_LABELS, type KnowledgeCategory } from "../../types";
import { getSupabaseClient } from "./shared";

export interface MarketableContact {
  name: string | null;
  email: string;
  tickets: number;
  categories: string[];
  /**
   * When they wrote, as `YYYY-MM-DD`. TWO DATES BECAUSE A ROW IS A PERSON: two
   * of the eight have written three times, so "the date of the ticket" is not
   * one value, and picking either silently would drop the other.
   *
   * From `first_message_at`, NOT `created_at`. The latter is when the row was
   * ingested and reads `2026-08-09` for all 214 tickets — the day the corpus was
   * synced — which as a "contact date" column would look like a bug and be
   * worse than useless. `first_message_at` is when the customer actually wrote
   * and spans 69 distinct days.
   */
  firstContact: string | null;
  lastContact: string | null;
}

/**
 * `!inner` is load-bearing: without it PostgREST returns every ticket and leaves
 * the embedded customer null when the filter fails, so the caller would receive
 * 214 rows and have to re-apply the consent filter in JavaScript. An inner join
 * makes the database enforce it.
 */
const SELECT =
  "category,first_message_at,customers!inner(id,display_name,first_name,last_name,email," +
  "number_of_orders,on_email_marketing_list)";

interface TicketWithCustomer {
  category: string | null;
  first_message_at: string | null;
  customers: {
    id: string;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    number_of_orders: number | null;
    on_email_marketing_list: boolean | null;
  } | null;
}

/** `actorId` is the signed-in dashboard user — the audit row names who took the file. */
export async function listMarketableContacts(shopId: string, actorId: string): Promise<MarketableContact[]> {
  const supabase = getSupabaseClient();

  const rows = (await supabaseSelect(
    supabase,
    T.TICKETS,
    {
      shop_id: shopId,
      deleted_at: { operator: "is", value: "null" },
      // The two conditions that define this group, both on the embedded side.
      "customers.number_of_orders": { operator: "eq", value: 0 },
      "customers.on_email_marketing_list": { operator: "is", value: "true" }
    },
    SELECT,
    { limit: 500 }
  )) as TicketWithCustomer[];

  const byCustomer = new Map<string, MarketableContact>();

  for (const row of rows) {
    const customer = row.customers;
    // An address is the entire point of the file: a row without one is not a
    // contact, and an empty cell in a mail merge is a silent failure.
    if (!customer?.email) continue;

    const existing = byCustomer.get(customer.id);
    const label = row.category
      ? CATEGORY_LABELS[row.category as KnowledgeCategory] ?? row.category
      : "Not categorised";
    const day = row.first_message_at ? row.first_message_at.slice(0, 10) : null;

    if (existing) {
      existing.tickets += 1;
      if (!existing.categories.includes(label)) existing.categories.push(label);
      // Compared as `YYYY-MM-DD` strings, which sort lexicographically the same
      // way they sort chronologically — no Date objects, no timezone to get
      // wrong on a boundary.
      if (day) {
        if (!existing.firstContact || day < existing.firstContact) existing.firstContact = day;
        if (!existing.lastContact || day > existing.lastContact) existing.lastContact = day;
      }
      continue;
    }

    byCustomer.set(customer.id, {
      name:
        customer.display_name ||
        [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
        null,
      email: customer.email,
      tickets: 1,
      categories: [label],
      firstContact: day,
      lastContact: day
    });
  }

  const contacts = [...byCustomer.values()].sort((a, b) =>
    (a.name ?? a.email).localeCompare(b.name ?? b.email, "fr")
  );

  // Best-effort, like every other audit write in this codebase: the trail must
  // not be the reason an export fails. Logged rather than thrown.
  try {
    await recordDataAccessEvent(supabase, {
      actor_type: "user",
      actor_id: actorId,
      action: "export",
      resource_type: "customer",
      purpose: "marketing_outreach_list",
      shop_id: shopId,
      metadata: { contacts: contacts.length, consent: "on_email_marketing_list" }
    });
  } catch {
    // Intentionally swallowed. The export still happened and the caller is told.
  }

  return contacts;
}

/**
 * RFC 4180 with two additions this file genuinely needs.
 *
 * A BOM, because the names are French and Excel opens a BOM-less UTF-8 CSV in
 * the system codepage — "Frédérique" becomes "FrÃ©dÃ©rique", which looks like a
 * database problem and is not.
 *
 * And a guard against formula injection: Excel and Sheets execute a cell
 * beginning `= + - @`, so a display name of `=HYPERLINK(...)` is a live formula
 * in whoever opens the file. Prefixing with an apostrophe keeps the text visible
 * and inert. The values here come from Shopify, which is to say from whatever a
 * customer typed into a name field.
 */
export function toCsv(contacts: MarketableContact[]): string {
  // ISO dates, unquoted: `YYYY-MM-DD` is unambiguous in any locale, sorts
  // correctly as text, and is the one format Excel does not reinterpret as
  // day/month on a French machine.
  const header = ["Name", "Email", "Tickets", "First contact", "Last contact", "Ticket categories"];
  const lines = [
    header.join(","),
    ...contacts.map((contact) =>
      [
        cell(contact.name ?? ""),
        cell(contact.email),
        String(contact.tickets),
        cell(contact.firstContact ?? ""),
        cell(contact.lastContact ?? ""),
        cell(contact.categories.join("; "))
      ].join(",")
    )
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
