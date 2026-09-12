import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authClient,
  canAccessPath,
  fallbackPath,
  needsRefresh,
} from "../scripts/lib/dashboard-auth.mjs";
import { clearSession, writeSession, type SupabaseSession } from "./lib/session-cookies";

/**
 * THE GATE. Every page and every API route passes through here, and nothing but
 * the login page and its three endpoints is reachable without a Supabase Auth
 * session.
 *
 * FAILS CLOSED. No Supabase configuration means no session can be checked, so
 * nobody gets in — the opposite failure (a missing key letting everyone
 * through) is the one that ends with the customer list on the open internet.
 *
 * A page without a session is sent to /login with its own address as `next`;
 * an API call gets a 401 (a redirect would hand a fetch() an HTML login page and
 * look like a parse error). A signed-in role asking for a page it may not open
 * is sent to the first page it may; the same API call gets a 403.
 *
 * IT ALSO KEEPS THE SESSION ALIVE. Supabase access tokens last an hour; when
 * one is spent this trades the refresh token for a new pair, writes both back,
 * and lets the request continue — so a twelve-hour day needs one sign-in, while
 * a disabled account stops working within a minute.
 */

const PUBLIC = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  const auth = authClient(process.env);
  if (!auth) return refuse(request, isApi, "Sign-in is not configured on this server.");

  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  let session = accessToken ? await auth.verifyAccessToken(accessToken) : { ok: false, reason: "invalid" };
  let refreshed: SupabaseSession | null = null;

  // One hour gone, or nearly — and the session as a whole still has time left.
  const spent = !session.ok && (session.reason === "expired" || session.reason === "invalid");
  const stale = session.ok && needsRefresh(session.payload);
  if (refreshToken && (spent || stale)) {
    const result = await auth.refresh(refreshToken);
    if (result.ok && result.session?.access_token) {
      const candidate = await auth.verifyAccessToken(result.session.access_token);
      if (candidate.ok) {
        session = candidate;
        refreshed = result.session;
      }
    }
  }

  if (!session.ok) return refuse(request, isApi, null);

  if (!canAccessPath(session.user.role, pathname)) {
    if (isApi) return NextResponse.json({ error: "Your role cannot open this." }, { status: 403 });
    return NextResponse.redirect(new URL(fallbackPath(session.user.role), request.url));
  }

  if (!refreshed) return NextResponse.next();

  // The new tokens go on the request too, so the page rendering behind this
  // middleware reads the fresh session rather than the one that just expired.
  request.cookies.set(ACCESS_COOKIE, refreshed.access_token);
  request.cookies.set(REFRESH_COOKIE, refreshed.refresh_token);
  const response = NextResponse.next({ request: { headers: request.headers } });
  writeSession(response, refreshed);
  return response;
}

function refuse(request: NextRequest, isApi: boolean, message: string | null) {
  if (isApi) {
    return NextResponse.json({ error: message ?? "Not signed in." }, { status: message ? 503 : 401 });
  }
  const { pathname, search } = request.nextUrl;
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  const response = NextResponse.redirect(login);
  // A cookie that no longer works is cleared on the way out, so the next
  // request is a clean "not signed in" rather than another failed check.
  clearSession(response);
  return response;
}

export const config = {
  // Everything except Next's own assets and static files.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)"],
};
