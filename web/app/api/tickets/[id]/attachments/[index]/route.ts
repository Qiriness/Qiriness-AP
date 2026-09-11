import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { getTicketPhoto } from "@/lib/server/attachment-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string; index: string };
}

/**
 * One photo from a ticket, proxied from the support mailbox.
 *
 * A BINARY RESPONSE, WHICH IS NEW FOR THIS API — every other route here answers
 * JSON. It exists because the alternative is a customer's photo stored on our
 * side (see `DECISIONS.md` § "The photo itself is not stored"), and because an
 * `<img>` cannot send an Authorization header: the browser asks for a URL under
 * this origin and the server is the only thing that ever speaks to Graph.
 *
 * THE FAILURE PATH IS A STATUS AND NOTHING ELSE. `getTicketPhoto` distinguishes
 * five reasons and the panel turns them into sentences; what must not happen is
 * a Graph error message reaching a browser, because it names the mailbox and the
 * Exchange item id. The reason travels as a header for an operator reading the
 * network tab, and the body stays empty.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const index = Number.parseInt(params.index, 10);
    const result = await getTicketPhoto(shopId, params.id, index);

    if (!result.ok) {
      const status = result.reason === "too_large" ? 413 : 404;
      return new NextResponse(null, {
        status,
        headers: { "X-Attachment-Reason": result.reason },
      });
    }

    return new NextResponse(result.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.body.byteLength),
        // `nosniff` with an explicit type: the type is the one we stored and
        // classified as an image, and this stops a browser deciding otherwise
        // about bytes that arrived from a mailbox.
        "X-Content-Type-Options": "nosniff",
        // `inline` so it renders in the panel; the filename is quoted for the
        // save dialog, stripped of anything that could break out of the header.
        "Content-Disposition": `inline; filename="${result.name.replace(/[^\w.\- ]+/g, "_")}"`,
        // NEVER a shared cache. This is one customer's photo, served to one
        // operator, from a dashboard that has no authentication yet.
        "Cache-Control": "private, no-store, max-age=0",
        // A photo of a parcel has no business in a third party's referrer log,
        // and nothing on this response should be framed.
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
