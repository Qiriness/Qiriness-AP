import {
  parseAllowedShops,
  verifyAppProxySignature,
} from "../../../../../scripts/lib/storefront-chat/app-proxy-signature.mjs";
import { customerIdentity } from "../../../../../scripts/lib/storefront-chat/customer-identity.mjs";
import { ChatRequestError, parseOpeningRequest } from "../../../../../scripts/lib/storefront-chat/request-schema.mjs";
import { handleStorefrontOpening } from "@/lib/server/storefront-chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * POST /api/storefront/opening — the widget's empty chat, asked on page load
 * (storefront `/apps/storefront-advisor/opening`, next to /chat). Same guards
 * as /chat: the app proxy signature, the shop allow-list, and who is asking
 * from the signed `logged_in_customer_id` only (STOREFRONT_CHAT_PURCHASE_HISTORY=on).
 *
 * 200 { reply } with a signed-in customer's repurchase message (owner,
 * 2026-10-29); 204 when there is none, which is every anonymous visit. A
 * failure is a 204 too: the greeting stands alone. Nothing is written here.
 */
export async function POST(request: Request) {
  const secret = process.env.STOREFRONT_APP_CLIENT_SECRET ?? "";
  if (!secret) return new Response("Not found.", { status: 404 });

  const query = new URL(request.url).searchParams;
  const proof = verifyAppProxySignature(query, secret);
  if (!proof.ok) return new Response(null, { status: 401 });
  if (!parseAllowedShops(process.env.STOREFRONT_CHAT_ALLOWED_SHOPS).has(proof.shop)) return new Response(null, { status: 403 });

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let parsed;
  try {
    parsed = parseOpeningRequest(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ChatRequestError) return new Response(null, { status: 400 });
    throw error;
  }

  try {
    const identity = customerIdentity(query, { shop: proof.shop, secret, env: process.env });
    const result = await handleStorefrontOpening(proof.shop, parsed, identity);
    if (!result) return new Response(null, { status: 204, headers: NO_STORE });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    console.warn("[storefront opening] none", error instanceof Error ? error.message : error);
    return new Response(null, { status: 204, headers: NO_STORE });
  }
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
