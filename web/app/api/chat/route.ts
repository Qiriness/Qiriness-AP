import { NextResponse, type NextRequest } from "next/server";

import { canUseManagementChat } from "../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { askQuestion } from "@/lib/server/chat-service";
import { MAX_QUESTION_CHARS, type ChatStreamLine } from "@/lib/chat-types";

export const dynamic = "force-dynamic";
// pg and the OpenAI transport are Node modules.
export const runtime = "nodejs";
// Up to eight model calls on a reasoning model, each possibly waiting out a 429.
export const maxDuration = 300;

/**
 * POST — ask the management chat a question, streaming the run as NDJSON.
 *
 * Body: `{question, conversationId?}`. No conversationId starts a new one.
 *
 * THE ROLE IS CHECKED HERE AS WELL AS IN THE MIDDLEWARE, for the reason
 * `getSession` gives: one bypass of the gate should not be a bypass of this.
 *
 * A stream for the same reason as the agent test chat: a run is several model
 * calls and SQL queries, and showing each query land is how a manager can see
 * what an answer rests on while it is being written.
 */
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!canUseManagementChat(user.role)) {
    return NextResponse.json({ error: "Your role cannot use the management chat." }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({}));
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId ? payload.conversationId : null;
  if (!question) return NextResponse.json({ error: "Ask a question." }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json({ error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (line: ChatStreamLine) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The client left. The turn carries on and is logged, so it is not lost.
        }
      };

      try {
        const result = await askQuestion({
          user,
          conversationId,
          question,
          onConversation: (id) => write({ stream: "conversation", conversationId: id }),
          onEvent: (event) => write({ stream: "step", event }),
        });
        write({ stream: "done", conversationId: result.conversationId, turn: result.turn });
      } catch (error) {
        write({
          stream: "failed",
          error: error instanceof Error ? error.message : "The question could not be answered.",
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
      "X-Accel-Buffering": "no",
    },
  });
}
