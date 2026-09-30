import { NextResponse } from "next/server";
import { AgentModelError, setAgentModel } from "@/lib/server/agent-settings-service";
import { getSession } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT `{agent, model}` — the model one agent runs on; `model: null` hands it
 * back to the env var. Closed to the contact team by the middleware
 * (dashboard-auth.mjs). The worker picks the change up on its next poll.
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const agent = typeof body?.agent === "string" ? body.agent : "";
    const model = typeof body?.model === "string" && body.model.trim() !== "" ? body.model.trim() : null;
    const user = await getSession();
    await setAgentModel(agent, model, user?.sub ?? null);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AgentModelError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
