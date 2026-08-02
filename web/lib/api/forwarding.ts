/**
 * Client-side wrapper around the Forwarding API (web/app/api/forwarding).
 * Mirrors ./knowledge.ts: the initial list is fetched server-side, this is for
 * the mutations a user triggers.
 */

import type { CategoryForwarding, KnowledgeCategory } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

export async function saveForwardingAddress(
  category: KnowledgeCategory,
  forwardEmail: string | null
): Promise<CategoryForwarding> {
  const response = await fetch("/api/forwarding", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, forwardEmail }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.entry as CategoryForwarding;
}
