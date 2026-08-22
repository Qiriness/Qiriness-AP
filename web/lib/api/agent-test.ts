/**
 * Client-side wrapper around the Agent test API (web/app/api/agent-test/*).
 *
 * The run itself is a STREAM, which is why this file exists rather than one more
 * `fetch().then(json)`: a rehearsal is tens of seconds across six model calls and
 * the transcript is meant to fill in as they land.
 */

import type { ArticleResult, Readiness, RunCost, RunDetail, RunSummary, TraceEvent } from "@/lib/agent-test-types";

export class AgentTestApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentTestApiError";
    this.status = status;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AgentTestApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body as T;
}

export async function fetchRuns(): Promise<{ runs: RunSummary[]; readiness: Readiness }> {
  return request("/api/agent-test/runs");
}

export async function fetchRun(id: string): Promise<RunDetail> {
  const { run } = await request<{ run: RunDetail }>(`/api/agent-test/runs/${id}`);
  return run;
}

export async function saveIdealAnswer(id: string, idealBody: string | null): Promise<RunDetail> {
  const { run } = await request<{ run: RunDetail }>(`/api/agent-test/runs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ idealBody }),
  });
  return run;
}

export async function deleteRun(id: string): Promise<void> {
  await request(`/api/agent-test/runs/${id}`, { method: "DELETE" });
}

export interface RunFinished {
  runId: string | null;
  status: "complete" | "gated" | "failed";
  summary: Record<string, unknown>;
  article: ArticleResult | null;
  tokens: { input: number; output: number; total: number; calls: number };
  cost: RunCost | null;
  error: string | null;
  stored: boolean;
}

export interface StartRunPayload {
  name?: string;
  email?: string;
  subject?: string;
  body: string;
  orderNumber?: string;
  expectDocumentId?: string | null;
  pastGate?: boolean;
}

/**
 * Starts a rehearsal and reads its NDJSON back line by line.
 *
 * A LINE MAY SPAN TWO CHUNKS, which is the one thing that makes this more than a
 * loop: the reader hands over whatever arrived, not whole lines. The tail is
 * carried into the next chunk, and only a complete line is ever parsed.
 *
 * `signal` aborts the READ, not the run: the passes are already paid for and the
 * server stores the row regardless, so an abandoned run still lands in the
 * history rather than vanishing.
 */
export async function streamRehearsal(
  payload: StartRunPayload,
  {
    onStep,
    signal,
  }: {
    onStep: (event: TraceEvent) => void;
    signal?: AbortSignal;
  }
): Promise<RunFinished> {
  const response = await fetch("/api/agent-test/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new AgentTestApiError(
      body?.error || `The rehearsal could not be started (${response.status}).`,
      response.status
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished: RunFinished | null = null;

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A malformed line is not worth losing the rest of a run over.
      return;
    }
    // `stream` is the envelope; a trace event keeps its own `type` untouched
    // inside `event`. They were once the same key, and the collision meant every
    // step was parsed, matched nothing, and was dropped in silence.
    if (parsed.stream === "step") {
      onStep(parsed.event as TraceEvent);
      return;
    }
    if (parsed.stream === "done") {
      finished = parsed as RunFinished;
      return;
    }
    if (parsed.stream === "failed") {
      throw new AgentTestApiError(parsed.error || "The rehearsal failed.", 500);
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  if (buffer) handle(buffer);

  if (!finished) {
    throw new AgentTestApiError("The rehearsal ended without a result.", 500);
  }
  return finished;
}
