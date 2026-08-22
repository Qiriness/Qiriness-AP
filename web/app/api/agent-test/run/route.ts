import type { NextRequest } from "next/server";

import { getShopId, rehearse } from "@/lib/server/agent-test-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
// The passes are Node modules reading Supabase over fetch and calling OpenAI;
// none of it runs on the edge.
export const runtime = "nodejs";
// Six model calls, two on the mid tier. The default 15s would cut the stream off
// somewhere inside the investigation, which is the interesting half.
export const maxDuration = 300;

/**
 * Runs one rehearsal, streaming its steps as NDJSON.
 *
 * WHY A STREAM AND NOT A REQUEST/RESPONSE. A run is tens of seconds across six
 * model calls, and watching each decision land — the labels, then each tool and
 * what it returned, then the case file, then the reply — is most of what the
 * feature is for. A spinner followed by a wall of JSON would answer the same
 * question far worse, and would give no way to see WHERE a slow run is.
 *
 * NDJSON rather than SSE: there is one consumer, it is our own fetch, and a line
 * per event needs no framing beyond a newline.
 *
 * Line shapes:
 *   {"type":"step", ...}   one trace event, exactly as it was recorded
 *   {"type":"done", ...}   the run finished — id, status, summary, cost
 *   {"type":"failed", ...} the run could not start, or threw outside a pass
 */
export async function POST(request: NextRequest) {
  let shopId: string;
  let payload: Record<string, unknown>;
  try {
    payload = await request.json().catch(() => ({}));
    shopId = await getShopId();
  } catch (error) {
    // Nothing has streamed yet, so a normal JSON error response is still open.
    return knowledgeErrorResponse(error);
  }

  const input = {
    name: text(payload.name),
    email: text(payload.email),
    subject: text(payload.subject),
    body: text(payload.body) ?? "",
    orderNumber: text(payload.orderNumber),
  };
  const expectDocumentId = text(payload.expectDocumentId);
  const pastGate = payload.pastGate === true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The client hung up mid-run. The passes keep going — they are already
          // paid for — and the row is still stored, so the run is not lost.
        }
      };

      try {
        const { runId, result, cost } = await rehearse({
          shopId,
          input,
          expectDocumentId,
          pastGate,
          onStep: (event) => write({ type: "step", ...(event as object) }),
        });
        write({
          type: "done",
          runId,
          status: result.status,
          summary: result.summary,
          article: result.article,
          tokens: result.tokens,
          cost,
          error: result.error,
          // Whether the run was stored. A rehearsal whose row failed to write is
          // still a valid run on screen, and saying so beats a history that
          // quietly lacks it.
          stored: Boolean(runId),
        });
      } catch (error) {
        write({
          type: "failed",
          error: error instanceof Error ? error.message : "The rehearsal could not be run.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Proxies that buffer would defeat the whole point.
      "X-Accel-Buffering": "no",
    },
  });
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
