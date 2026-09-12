import type { NextResponse } from "next/server";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  decodeJwt,
  sessionCookieOptions,
  sessionSecondsLeft,
} from "../../scripts/lib/dashboard-auth.mjs";

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
}

/**
 * Write the session Supabase just issued.
 *
 * Both cookies expire with the SESSION — twelve hours from when the password
 * was typed — not with the access token, which lasts an hour. The pair is
 * useless without a refresh token, and a refresh token whose session has aged
 * out is refused anyway, so the shorter cookie life would only log people out
 * early.
 */
export function writeSession(response: NextResponse, session: SupabaseSession) {
  const maxAge = Math.max(60, sessionSecondsLeft(decodeJwt(session.access_token)?.payload));
  const options = sessionCookieOptions({ secure: process.env.NODE_ENV === "production", maxAge });
  response.cookies.set(ACCESS_COOKIE, session.access_token, options);
  response.cookies.set(REFRESH_COOKIE, session.refresh_token, options);
}

/** Clear both, for sign-out and for a session that no longer verifies. */
export function clearSession(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}
