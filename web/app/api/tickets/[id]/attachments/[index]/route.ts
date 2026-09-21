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
      // A 404 SAYS "THIS PHOTO IS NOT HERE", which is true of a message that has
      // left the mailbox and false of a deployment with no Graph credentials —
      // and the second is somebody's afternoon, not a lost mail. It gets a 503
      // so the status alone separates "gone" from "broken" in a log, a network
      // tab or an uptime check, none of which read the reason header.
      const status =
        result.reason === "too_large" ? 413 : result.reason === "graph_not_configured" ? 503 : 404;
      // THE REASON IS ALSO THE BODY, and `detail` still never is. The slug is a
      // closed enum naming a class of failure; `detail` is Graph's own text and
      // carries the mailbox address and the Exchange item id, which is why it
      // stays server-side. Splitting them is what makes this safe to show.
      //
      // An empty body was the original choice and it cost three days on
      // 2026-09-20: opening the URL directly to find out why a photo would not
      // load gave `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, which is Chrome's way
      // of saying "an error status with nothing in it" and names no cause. The
      // header was always there and a browser address bar cannot show one.
      return new NextResponse(result.reason, {
        status,
        headers: {
          "X-Attachment-Reason": result.reason,
          // Explicit, with `nosniff`: this is the one response on this route
          // that is deliberately not an image, and nothing should guess at it.
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store, max-age=0",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
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
