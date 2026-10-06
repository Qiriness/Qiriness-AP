import {
  parseAllowedShops,
  verifyAppProxySignature,
} from "../../../../../scripts/lib/storefront-chat/app-proxy-signature.mjs";
import {
  ChatRequestError,
  MAX_BODY_BYTES,
  parseChatRequest,
} from "../../../../../scripts/lib/storefront-chat/request-schema.mjs";
import { handleStorefrontChat } from "@/lib/server/storefront-chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/storefront/chat — the storefront advisor, reached ONLY through the
 * Shopify app proxy (storefront `/apps/storefront-advisor/chat`).
 *
 * PUBLIC TO THE MIDDLEWARE, like the webhooks: a storefront visitor holds no
 * dashboard session. The proof is the app proxy signature (an HMAC over the
 * query, keyed with the advisor app's client secret), then the shop allow-list.
 * Both fail closed:
 *   - no STOREFRONT_APP_CLIENT_SECRET -> 404, the route does not exist;
 *   - a bad or stale signature        -> 401;
 *   - a shop not in STOREFRONT_CHAT_ALLOWED_SHOPS (empty = none) -> 403.
 * The allow-list is the second guard that keeps the advisor off production.
 *
 * Errors are codes, never internals: the browser is the public internet.
 */
export async function POST(request: Request) {
  const secret = process.env.STOREFRONT_APP_CLIENT_SECRET ?? "";
  if (!secret) return new Response("Not found.", { status: 404 });

  const proof = verifyAppProxySignature(new URL(request.url).searchParams, secret);
  if (!proof.ok) return fail(401, "unauthorised");
  if (!parseAllowedShops(process.env.STOREFRONT_CHAT_ALLOWED_SHOPS).has(proof.shop)) return fail(403, "shop_not_allowed");

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return fail(413, "too_large");

  let parsed;
  try {
    parsed = parseChatRequest(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ChatRequestError) return fail(400, "invalid_request");
    throw error;
  }

  try {
    const result = await handleStorefrontChat(proof.shop, parsed);
    if (!result.ok) return fail(result.status, result.code);
    return Response.json({ sessionId: result.sessionId, reply: result.reply }, { headers: NO_STORE });
  } catch (error) {
    console.error("[storefront chat] failed", error instanceof Error ? error.message : error);
    return fail(500, "unavailable");
  }
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function fail(status: number, code: string) {
  return Response.json({ error: { code } }, { status, headers: NO_STORE });
}
