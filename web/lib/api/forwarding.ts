/**
 * Client-side wrapper around the Forwarding API (web/app/api/forwarding).
 * Mirrors ./knowledge.ts: the initial configuration is fetched server-side,
 * this is for the mutations a user triggers.
 */

import type {
  ForwardingAckSettings,
  ForwardingDestination,
  ForwardingDestinationInput,
} from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

async function send<R>(url: string, method: string, payload?: unknown): Promise<R> {
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (response.status === 204) {
    return undefined as R;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body as R;
}

export async function createForwardingDestination(input: ForwardingDestinationInput): Promise<ForwardingDestination> {
  const body = await send<{ destination: ForwardingDestination }>("/api/forwarding/destinations", "POST", input);
  return body.destination;
}

export async function updateForwardingDestination(
  id: string,
  input: ForwardingDestinationInput
): Promise<ForwardingDestination> {
  const body = await send<{ destination: ForwardingDestination }>(
    `/api/forwarding/destinations/${encodeURIComponent(id)}`,
    "PUT",
    input
  );
  return body.destination;
}

/** Switches one destination on or off. */
export async function setForwardingDestinationOn(id: string, on: boolean): Promise<ForwardingDestination> {
  const body = await send<{ destination: ForwardingDestination }>(
    `/api/forwarding/destinations/${encodeURIComponent(id)}`,
    "PATCH",
    { on }
  );
  return body.destination;
}

export async function deleteForwardingDestination(id: string): Promise<void> {
  await send<void>(`/api/forwarding/destinations/${encodeURIComponent(id)}`, "DELETE");
}

/** Turns forwarding on (from now, or the start date it already has) or off. Returns the start date. */
export async function setForwardingOn(on: boolean): Promise<string | null> {
  const body = await send<{ forwardSince: string | null }>("/api/forwarding/settings", "PUT", { forwardingOn: on });
  return body.forwardSince;
}

export async function saveForwardingAckSettings(settings: ForwardingAckSettings): Promise<ForwardingAckSettings> {
  const body = await send<{ settings: ForwardingAckSettings }>("/api/forwarding/settings", "PUT", settings);
  return body.settings;
}
