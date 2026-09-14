import { NextResponse } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { findSegment } from "@/lib/server/insights/segment-finder-service";
import type { SegmentDefinition } from "@/lib/types";
import { validateSegment } from "../../../../../scripts/lib/segment-finder.mjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST — find the customers a segment matches:
 * `{windowMonths, conditions: [{metric, op, value}], connectors: ['and'|'or']}`.
 *
 * A POST although it reads nothing but the database: the segment is a
 * structure, and a query string of nested conditions would be the harder of the
 * two to validate. Validated before any read; `no-store` because the answer
 * names customers.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const checked = validateSegment(body);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
    }
    const shopId = await getShopId();
    const result = await findSegment(shopId, checked.segment as SegmentDefinition);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not find this segment." },
      { status: 500, headers: NO_STORE }
    );
  }
}
