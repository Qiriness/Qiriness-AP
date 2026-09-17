import { NextResponse } from "next/server";

import { getShopId, listCollections } from "@/lib/server/collections-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Every collection the shop has, active ones first.
 *
 * THE WHOLE LIST, NOT A SEARCH ENDPOINT. 175 rows without their membership is a
 * small read, and the screen filters in the browser — a server-side search would
 * mean a round trip per keystroke to narrow a list that fits in memory twice
 * over, and `ProductAttachSelect` already established that a catalogue of this
 * size is cheaper fetched once.
 */
export async function GET() {
  try {
    return NextResponse.json({ collections: await listCollections(await getShopId()) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
