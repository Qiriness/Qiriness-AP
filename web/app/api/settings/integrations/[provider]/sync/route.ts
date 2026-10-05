import { NextResponse } from "next/server";
import { getSocialConnections, isProvider, queueSync } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST — « Sync now ». Queues a `sync_social` job for the worker and answers at
 * once; the dialog shows « queued » until the worker's sync lands. Repeated
 * clicks collapse into the job already queued.
 */
export async function POST(_request: Request, { params }: { params: { provider: string } }) {
  if (!isProvider(params.provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, headers: NO_STORE });
  try {
    const status = await getSocialConnections();
    if (!status.providers.find((p) => p.provider === params.provider)?.connected) {
      return NextResponse.json({ error: "Not connected" }, { status: 409, headers: NO_STORE });
    }
    await queueSync(params.provider);
    return NextResponse.json(await getSocialConnections(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
