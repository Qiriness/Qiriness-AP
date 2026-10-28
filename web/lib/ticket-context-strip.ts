/**
 * The context strip under the ticket header: the few facts a reviewer needs
 * before reading the thread, chosen by what the ticket is about.
 *
 * A delivery question shows the parcel; a return shows the order and its
 * state; a product question with no order shows the language and that no order
 * is linked. The references written in the mail (`Q00…`, invoices, shipments)
 * are gathered once across the thread here instead of being chipped under every
 * message. The next action and how an approval leaves (sent, Outlook draft, or
 * recorded only) are always there, because they are what the reply depends on.
 *
 * Pure: facts in, pieces out. The component decides how each piece looks.
 */
import type { KnowledgeCategory, TicketDetail, TicketListItem, TicketThread } from "./types";

export type StripPiece =
  | { kind: "order"; value: string }
  | { kind: "orderStatus"; value: string }
  | { kind: "delivery"; value: string }
  | { kind: "parcel"; value: string; carrier: string | null; url: string | null }
  | { kind: "channel"; value: string }
  | { kind: "reference"; value: string }
  | { kind: "language"; value: string }
  | { kind: "noOrder" };

/** How approving the current draft leaves the desk. Null when there is no draft to approve. */
export type ApprovalRoute = "sends" | "outlook" | "records" | null;

export interface ContextStrip {
  pieces: StripPiece[];
  action: string | null;
  approval: ApprovalRoute;
}

type Profile = { orderStatus: boolean; delivery: boolean; parcels: boolean; languageWithoutOrder: boolean };

const ORDER_PROFILE: Profile = { orderStatus: true, delivery: true, parcels: false, languageWithoutOrder: false };
const DELIVERY_PROFILE: Profile = { orderStatus: true, delivery: true, parcels: true, languageWithoutOrder: false };
const RETURN_PROFILE: Profile = { orderStatus: true, delivery: false, parcels: false, languageWithoutOrder: false };
const ADVICE_PROFILE: Profile = { orderStatus: false, delivery: false, parcels: false, languageWithoutOrder: true };

/**
 * Which facts each subject of the taxonomy leads with. A subject not listed
 * (and an uncategorised ticket) gets the advice profile: order if there is one,
 * otherwise the language.
 */
export const STRIP_PROFILES: Partial<Record<KnowledgeCategory, Profile>> = {
  order: ORDER_PROFILE,
  payment: ORDER_PROFILE,
  product_stock: ORDER_PROFILE,
  delivery: DELIVERY_PROFILE,
  return_exchange: RETURN_PROFILE,
};

/** The non-Shopify references the order parser classifies (agent/src/resolution/order-number-parser.mjs). */
const REFERENCE_PATTERNS = [/\bQ0{0,2}\s?\d{6,}\b/gi, /\b(?:CL|FA|DS)\s?\d{4,}\b/gi];
const MAX_REFERENCES = 4;

export function references(thread: Pick<TicketThread, "messages"> | null): string[] {
  const seen = new Map<string, string>();
  for (const message of thread?.messages ?? []) {
    const text = `${message.subject ?? ""}\n${message.bodyClean ?? ""}`;
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const key = match[0].replace(/\s+/g, "").toUpperCase();
        if (!seen.has(key)) seen.set(key, match[0].trim());
      }
    }
  }
  return [...seen.values()].slice(0, MAX_REFERENCES);
}

export function approvalRoute(thread: Pick<TicketThread, "draft"> | null): ApprovalRoute {
  const draft = thread?.draft;
  if (!draft || draft.status === "stale") return null;
  if (draft.sendsOnApprove) return "sends";
  if (draft.holdsInDrafts) return "outlook";
  return "records";
}

export function contextStrip(
  ticket: Pick<TicketListItem, "category" | "orderNumber" | "language">,
  detail: Pick<TicketDetail, "order" | "results"> | null,
  thread: Pick<TicketThread, "messages" | "draft"> | null
): ContextStrip {
  const profile = (ticket.category && STRIP_PROFILES[ticket.category]) || ADVICE_PROFILE;
  const order = detail?.order ?? null;
  const pieces: StripPiece[] = [];

  const orderName = order?.orderName ?? (ticket.orderNumber ? `#${String(ticket.orderNumber).replace(/^#/, "")}` : null);
  if (orderName) pieces.push({ kind: "order", value: orderName });
  if (order) {
    if (profile.orderStatus && order.orderStatus) pieces.push({ kind: "orderStatus", value: order.orderStatus });
    if (profile.delivery && order.trackingStatus) pieces.push({ kind: "delivery", value: order.trackingStatus });
    if (profile.parcels) {
      for (const parcel of order.tracking.slice(0, 2)) {
        pieces.push({ kind: "parcel", value: parcel.number, carrier: parcel.carrier, url: parcel.url });
      }
    }
    // A marketplace order behaves differently whatever it is about (no parcel on most Amazon orders).
    if (order.channel) pieces.push({ kind: "channel", value: order.channel });
  }
  for (const value of references(thread)) pieces.push({ kind: "reference", value });
  if (!orderName && profile.languageWithoutOrder) {
    if (ticket.language) pieces.push({ kind: "language", value: ticket.language });
    pieces.push({ kind: "noOrder" });
  }

  return {
    pieces,
    action: detail?.results?.action?.trim() || null,
    approval: approvalRoute(thread),
  };
}
