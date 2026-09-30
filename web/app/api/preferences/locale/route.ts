import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n/locales";

export const dynamic = "force-dynamic";

const ONE_YEAR = 365 * 24 * 60 * 60;

/**
 * PUT {locale} — the signed-in person's interface language.
 *
 * The cookie is what the pages read; the copy on the account's
 * `user_metadata.locale` is what follows them to another browser (sign-in
 * restores the cookie from it). The metadata write uses the person's OWN access
 * token, so no service key is involved and it can only touch their own record —
 * and it is best effort: a failure still leaves the cookie set.
 *
 * Nothing here touches what the agent writes to customers.
 */
export async function PUT(request: Request) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!isLocale(body?.locale)) return NextResponse.json({ error: "Unknown language." }, { status: 400 });

  const response = NextResponse.json({ ok: true, locale: body.locale }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(LOCALE_COOKIE, body.locale, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR,
    secure: process.env.NODE_ENV === "production",
  });

  const token = request.headers.get("cookie")?.match(new RegExp(`${ACCESS_COOKIE}=([^;]+)`))?.[1];
  const url = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (token && url && apiKey) {
    // user_metadata is replaced key-by-key at the top level, so display_name survives.
    await fetch(`${url}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: apiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { locale: body.locale } }),
    }).catch(() => undefined);
  }
  return response;
}
