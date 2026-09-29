import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { deleteDestination, setDestinationOn, updateDestination } from "@/lib/server/forwarding-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

/** Replaces one destination whole. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const body = await request.json().catch(() => ({}));
    const destination = await updateDestination(await getShopId(), params.id, body);
    return NextResponse.json({ destination });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Switches one destination on (`{ on: true }`) or off. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.on !== "boolean") {
      return NextResponse.json({ error: "on must be true or false." }, { status: 400 });
    }
    const destination = await setDestinationOn(await getShopId(), params.id, body.on);
    return NextResponse.json({ destination });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Removes a destination. Forwards already sent keep their own record of where they went. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    await deleteDestination(await getShopId(), params.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
