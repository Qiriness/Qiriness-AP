import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { addSender, listSenders } from "@/lib/server/senders-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** The sender directory, with what each row counts as on a case. */
export async function GET() {
  try {
    return NextResponse.json({ senders: await listSenders(await getShopId()) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Adds an address or a domain with its label. Returns the whole directory. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ senders: await addSender(await getShopId(), body ?? {}) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
