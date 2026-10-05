import { NextResponse } from "next/server";
import { disconnect, getSocialConnections, isProvider } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * DELETE — the provider's token leaves Vault. Accounts and everything synced
 * stay, so the panel keeps its history; connecting again resumes the sync.
 * (The static `klaviyo/` route beside this one takes precedence over it.)
 */
export async function DELETE(_request: Request, { params }: { params: { provider: string } }) {
  if (!isProvider(params.provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, headers: NO_STORE });
  try {
    await disconnect(params.provider);
    return NextResponse.json(await getSocialConnections(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
