import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { STATE_COOKIE, isProvider, startConnect } from "@/lib/server/social-connections-service";
import { returnPath } from "@/lib/server/social-return";

export const dynamic = "force-dynamic";

/**
 * GET — off to the provider's consent screen. A plain link, not a fetch: the
 * browser has to leave for facebook.com / accounts.google.com and come back to
 * the callback. The state's nonce rides in an httpOnly cookie, so the answer is
 * only accepted in the browser that asked. `?return=` picks where the person
 * lands afterwards, from a fixed list.
 */
export async function GET(request: NextRequest, { params }: { params: { provider: string } }) {
  const back = returnPath(request.nextUrl.searchParams.get("return"));
  if (!isProvider(params.provider)) return NextResponse.redirect(new URL(`${back}&connect_error=unknown`, request.url));

  const session = await getSession();
  const started = await startConnect(params.provider, request.nextUrl.origin, session?.sub ?? null);
  if (!started.ok) {
    return NextResponse.redirect(new URL(`${back}&connect_error=${started.error}&provider=${params.provider}`, request.url));
  }

  const response = NextResponse.redirect(started.url);
  response.cookies.set(STATE_COOKIE, JSON.stringify({ nonce: started.nonce, back }), {
    httpOnly: true,
    // Lax: the provider's redirect back is a top-level GET from another site,
    // which Lax lets through and Strict would not.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/settings/integrations",
    maxAge: 10 * 60,
  });
  return response;
}
