/**
 * Client-side wrapper around /api/company-policies: the library screen and the
 * « Linked policies » blocks on the rulebook.
 */
import type { CompanyPolicy, CompanyPolicyLink } from "../types";
import { KnowledgeApiError } from "./knowledge";

async function send<T>(url: string, init: RequestInit, pick: (body: any) => T): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return pick(body);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function createPolicy(input: { key: string; name: string; purpose: string; content: string; active: boolean }): Promise<CompanyPolicy> {
  return send("/api/company-policies", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) }, (b) => b.policy);
}

export function savePolicy(
  key: string,
  input: { name?: string; purpose?: string; content?: string; active?: boolean; expectedVersion?: number }
): Promise<CompanyPolicy> {
  return send(`/api/company-policies/${encodeURIComponent(key)}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(input) }, (b) => b.policy);
}

export function linkPolicy(input: { policyKey: string; situationKey?: string | null; answerId?: string | null }): Promise<CompanyPolicyLink> {
  return send("/api/company-policies/links", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) }, (b) => b.link);
}

export function unlinkPolicy(linkId: string): Promise<boolean> {
  return send(`/api/company-policies/links?id=${encodeURIComponent(linkId)}`, { method: "DELETE" }, (b) => Boolean(b.removed));
}
