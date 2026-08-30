/**
 * Client-side wrapper around the policy-rule API (web/app/api/policy/*).
 *
 * The initial list is fetched server-side in the page for the same reason the
 * article list is — so the screen renders with real rules on first paint rather
 * than flashing empty — and everything the operator does afterwards comes back
 * through here.
 */

import { KnowledgeApiError } from "@/lib/api/knowledge";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

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

export interface PolicyPayload {
  rules: PolicyRule[];
  situations: PolicySituation[];
  vocabulary: PolicyVocabulary;
}

export function fetchPolicy(): Promise<PolicyPayload> {
  return request<PolicyPayload>("/api/policy/rules", { cache: "no-store" });
}

export interface SaveRulePayload {
  answerSet: string;
  answerKey: string;
  situationKey: string | null;
  conditions: Record<string, string[]>;
  answerSkeleton: string | null;
  route: string | null;
  ask: string | null;
  priority: number;
  isFallback: boolean;
}

/**
 * Saves a rule. It always comes back as a DRAFT — approving is a separate call,
 * so editing a live rule takes it off the mail until somebody approves it again.
 */
export async function saveRule(payload: SaveRulePayload): Promise<PolicyRule> {
  const { rule } = await request<{ rule: PolicyRule }>("/api/policy/rules", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return rule;
}

export async function setRuleApproval(id: string, approved: boolean): Promise<PolicyRule> {
  const { rule } = await request<{ rule: PolicyRule }>(`/api/policy/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ approved }),
  });
  return rule;
}

export async function deleteRule(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/policy/rules/${id}`, { method: "DELETE" });
}
