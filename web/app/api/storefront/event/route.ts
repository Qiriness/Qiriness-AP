import {
  parseAllowedShops,
  verifyAppProxySignature,
} from "../../../../../scripts/lib/storefront-chat/app-proxy-signature.mjs";
import { recordProductClick } from "@/lib/server/storefront-chat-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024;

/**
 * POST /api/storefront/event — a product card click in the storefront advisor
 * (`/apps/storefront-advisor/event`), recorded as an advisory event.
 *
 * The same guards as /api/storefront/chat: app proxy signature, shop
 * allow-list, both failing closed. The body is `{ sessionId, productId }`,
 * both uuids; the session must belong to the signed shop. Always 204 for a
 * well-formed request: a click beacon has nobody to show an error to.
 */
export async function POST(request: Request) {
  const secret = process.env.STOREFRONT_APP_CLIENT_SECRET ?? "";
  if (!secret) return new Response("Not found.", { status: 404 });

  const proof = verifyAppProxySignature(new URL(request.url).searchParams, secret);
  if (!proof.ok) return new Response(null, { status: 401 });
  if (!parseAllowedShops(process.env.STOREFRONT_CHAT_ALLOWED_SHOPS).has(proof.shop)) return new Response(null, { status: 403 });

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let body: { sessionId?: unknown; productId?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof body.sessionId !== "string" || !UUID.test(body.sessionId) || typeof body.productId !== "string" || !UUID.test(body.productId)) {
    return new Response(null, { status: 400 });
  }
  try {
    await recordProductClick(proof.shop, body.sessionId.toLowerCase(), body.productId.toLowerCase());
  } catch (error) {
    console.warn("[storefront event] not recorded", error instanceof Error ? error.message : error);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
