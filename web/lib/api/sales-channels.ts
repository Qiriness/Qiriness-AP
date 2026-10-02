import type { SalesChannelsView } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

async function call(url: string, init: RequestInit): Promise<SalesChannelsView> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.salesChannels as SalesChannelsView;
}

export interface SalesChannelInput {
  label?: string;
  handles?: string[];
  analyticsNames?: string[];
}

export function addSalesChannel(input: SalesChannelInput): Promise<SalesChannelsView> {
  return call("/api/sales-channels", { method: "POST", body: JSON.stringify(input) });
}

export function updateSalesChannel(id: string, input: SalesChannelInput): Promise<SalesChannelsView> {
  return call(`/api/sales-channels/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteSalesChannel(id: string): Promise<SalesChannelsView> {
  return call(`/api/sales-channels/${id}`, { method: "DELETE" });
}
