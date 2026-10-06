import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

/**
 * The ↻ button: forget every cached Insights figure, so the render that follows
 * reads them fresh. The five-minute auto-refresh does not come here; it re-reads
 * the cache, which is what keeps an open tab from costing anything.
 */
export async function POST() {
  revalidateTag(CACHE_TAGS.insights);
  return NextResponse.json({ ok: true });
}
