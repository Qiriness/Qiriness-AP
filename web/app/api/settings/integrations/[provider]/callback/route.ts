import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { STATE_COOKIE, completeConnect, isProvider } from "@/lib/server/social-connections-service";
import { knownReturn } from "@/lib/server/social-return";

export const dynamic = "force-dynamic";

/**
 * GET — where Meta / Google send the person back, with `code` and `state` (or
 * `error` when they declined). The state is checked against this browser's
 * cookie, the code exchanged, the token stored in Vault, the accounts found,
 * and a first sync queued for the worker. The person lands back on the page
 * they came from with `connected=` or `connect_error=` — a short code, never
 * the provider's text.
 *
 * Behind the session gate like every other integrations route: Lax cookies
 * travel with this top-level redirect, so the person is still signed in.
 */
export async function GET(request: NextRequest, { params }: { params: { provider: string } }) {
  let stored: { nonce?: string; back?: string } = {};
  try {
    stored = JSON.parse(request.cookies.get(STATE_COOKIE)?.value ?? "{}");
  } catch {
    stored = {};
  }
  const back = knownReturn(stored.back);
  const land = (query: string) => {
    const response = NextResponse.redirect(new URL(`${back}&${query}`, request.url));
    response.cookies.set(STATE_COOKIE, "", { path: "/api/settings/integrations", maxAge: 0 });
    return response;
  };

  if (!isProvider(params.provider)) return land("connect_error=unknown");

  const search = request.nextUrl.searchParams;
  const session = await getSession();
  const result = await completeConnect(params.provider, {
    code: search.get("code"),
    state: search.get("state"),
    providerError: search.get("error"),
    cookieNonce: stored.nonce,
    origin: request.nextUrl.origin,
    userId: session?.sub ?? null,
  });

  return result.ok
    ? land(`connected=${params.provider}`)
    : land(`connect_error=${encodeURIComponent(result.code)}&provider=${params.provider}`);
}
