import type { SenderDirectoryView, SenderLabel } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

async function call(url: string, init: RequestInit): Promise<SenderDirectoryView> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.senders as SenderDirectoryView;
}

export function addSender(input: {
  patternType: "email" | "domain";
  pattern: string;
  label: SenderLabel;
  note: string;
}): Promise<SenderDirectoryView> {
  return call("/api/senders", { method: "POST", body: JSON.stringify(input) });
}

export function updateSender(id: string, input: { label?: SenderLabel; note?: string }): Promise<SenderDirectoryView> {
  return call(`/api/senders/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteSender(id: string): Promise<SenderDirectoryView> {
  return call(`/api/senders/${id}`, { method: "DELETE" });
}
