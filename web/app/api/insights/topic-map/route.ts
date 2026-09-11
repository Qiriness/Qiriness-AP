import { NextResponse } from "next/server";
import { rebuildTopicMap } from "@/lib/server/insights/topic-map-rebuild";

export const dynamic = "force-dynamic";

/** POST — rebuild the topic map at the script's default settings. No body, no arguments. */
export async function POST() {
  try {
    const result = await rebuildTopicMap();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The rebuild failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
