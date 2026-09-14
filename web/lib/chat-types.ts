/**
 * The management chat's data contract, shared by the API routes and the UI.
 * Isomorphic: types only.
 */

export type ChatTurnStatus = "running" | "ok" | "step_limit" | "empty" | "error";

/** One SQL query the model ran, as the UI shows it. `rows` is a preview, not the full result. */
export interface ChatQueryView {
  step: number;
  sql: string;
  ok: boolean;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error: string | null;
  columns: string[];
  rows: unknown[][];
}

export interface ChatTurnView {
  id: string;
  question: string;
  answer: string | null;
  status: ChatTurnStatus;
  error: string | null;
  model: string;
  steps: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  /** Priced at read time from llm-rates.mjs; null when the model has no rate there. */
  costUsd: number | null;
  createdAt: string;
  queries: ChatQueryView[];
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatConversationDetail extends ChatConversationSummary {
  turns: ChatTurnView[];
}

export interface ChatReadiness {
  ready: boolean;
  model: string;
  /** Why the chat cannot run, in words for the page. Empty when ready. */
  problems: string[];
}

export type ChatStepEvent =
  | { type: "thinking"; step: number }
  | { type: "query_started"; step: number; sql: string }
  | { type: "query_finished"; query: ChatQueryView };

/**
 * One NDJSON line from POST /api/chat. The payload is nested under `stream` so
 * an event's own `type` can never overwrite the envelope — the bug the agent
 * test chat hit (web/app/api/agent-test/run/route.ts).
 */
export type ChatStreamLine =
  | { stream: "conversation"; conversationId: string }
  | { stream: "step"; event: ChatStepEvent }
  | { stream: "done"; conversationId: string; turn: ChatTurnView }
  | { stream: "failed"; error: string; conversationId?: string };

export const MAX_QUESTION_CHARS = 2000;
