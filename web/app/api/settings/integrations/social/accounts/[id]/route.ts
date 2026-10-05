import { NextResponse } from "next/server";
import { getSocialConnections, setTracked } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** PATCH `{enabled}` — track an account or stop. Its stored figures stay either way. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400, headers: NO_STORE });
    }
    const found = await setTracked(params.id, body.enabled);
    if (!found) return NextResponse.json({ error: "No such account" }, { status: 404, headers: NO_STORE });
    return NextResponse.json(await getSocialConnections(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
