/**
 * Client-side wrapper around the collections API (web/app/api/collections/*).
 *
 * The initial list is fetched server-side in the page, like every other setup
 * screen, so it renders with the real collections rather than flashing empty —
 * which on this screen would read as "nothing is curated" rather than "still
 * loading", and those are opposite facts.
 *
 * TWO CALLS, NOT ONE, because the server keeps them apart: activating is what
 * lets a collection reach a customer, and setting its axis or note is
 * bookkeeping. A single `save` here would put them back together on the client
 * and invite a caller to send both at once.
 */

import { KnowledgeApiError } from "@/lib/api/knowledge";
import type { AdviceCollection, CollectionAxis } from "@/lib/types";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body as T;
}

export async function listCollections(): Promise<AdviceCollection[]> {
  const body = await request<{ collections: AdviceCollection[] }>("/api/collections");
  return body.collections ?? [];
}

/** Switches one collection on or off for advice. */
export async function setCollectionActive(id: string, active: boolean): Promise<AdviceCollection> {
  const body = await request<{ collection: AdviceCollection }>(`/api/collections/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
  return body.collection;
}

/** Sets what the collection is. Never switches it on or off. */
export async function setCollectionDetails(
  id: string,
  details: { axis: CollectionAxis | null; note: string | null }
): Promise<AdviceCollection> {
  const body = await request<{ collection: AdviceCollection }>(`/api/collections/${id}`, {
    method: "PUT",
    body: JSON.stringify(details),
  });
  return body.collection;
}

/**
 * Runs the sync now and returns the refreshed list.
 *
 * The whole list rather than the counts, so the screen redraws from what the
 * sync just wrote instead of the state it had before.
 */
export async function syncCollections(): Promise<{
  collections: AdviceCollection[];
  synced: { total: number; refreshed: number; memberships: number };
}> {
  return request("/api/collections/sync", { method: "POST" });
}
