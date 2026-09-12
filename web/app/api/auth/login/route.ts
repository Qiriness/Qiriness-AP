import { NextResponse } from "next/server";
import {
  ROLE_LABELS,
  authClient,
  dashboardRoleOf,
  isBanned,
  normaliseEmail,
  safeNextPath,
} from "../../../../../scripts/lib/dashboard-auth.mjs";
import { writeSession } from "@/lib/session-cookies";

export const dynamic = "force-dynamic";

/**
 * POST {email, password, next} — sign in through Supabase Auth.
 *
 * ONE ANSWER FOR EVERY FAILURE. A wrong address, a wrong password, a disabled
 * account and an account with no dashboard role all get "Email or password is
 * incorrect", so the reply never says which addresses have accounts.
 *
 * FIVE TRIES PER ADDRESS PER FIFTEEN MINUTES, counted in this process — on top
 * of Supabase's own limits, which see this server's address rather than the
 * visitor's and so cannot tell one persistent guesser from the whole team. In
 * memory, so a restart resets it; a shared store is the upgrade if the dashboard
 * ever runs on several servers.
 *
 * AN ACCOUNT WITHOUT A ROLE IS SIGNED STRAIGHT BACK OUT. Supabase sign-up is a
 * project-level setting; if it is ever left on, an account created that way
 * gets no dashboard role, and this makes sure it does not even keep a session.
 *
 * Logged without the address or the password: outcome and user id only.
 */

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; since: number }>();

function throttled(key: string, now: number): boolean {
  const entry = failures.get(key);
  if (!entry || now - entry.since > WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

function noteFailure(key: string, now: number) {
  const entry = failures.get(key);
  if (!entry || now - entry.since > WINDOW_MS) failures.set(key, { count: 1, since: now });
  else entry.count += 1;
}

const refused = () =>
  NextResponse.json(
    { error: "Email or password is incorrect." },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );

export async function POST(request: Request) {
  const now = Date.now();
  const body = await request.json().catch(() => ({}));
  const email = normaliseEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) return refused();
  if (throttled(email, now)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait fifteen minutes and try again." },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  const auth = authClient(process.env);
  if (!auth) {
    console.error(JSON.stringify({ event: "auth.login", outcome: "misconfigured" }));
    return NextResponse.json({ error: "Sign-in is not configured on this server." }, { status: 503 });
  }

  const result = await auth.signIn(email, password);
  if (!result.ok) {
    noteFailure(email, now);
    console.info(JSON.stringify({ event: "auth.login", outcome: "refused", code: result.code ?? null }));
    return refused();
  }

  const user = result.session?.user;
  const role = dashboardRoleOf(user);
  if (!role || isBanned(user, now)) {
    await auth.signOut(result.session.access_token);
    noteFailure(email, now);
    console.warn(JSON.stringify({ event: "auth.login", outcome: "no_role", user: user?.id ?? null }));
    return refused();
  }

  failures.delete(email);
  console.info(JSON.stringify({ event: "auth.login", outcome: "ok", user: user.id, role }));

  const response = NextResponse.json(
    { ok: true, next: safeNextPath(body?.next), role, roleLabel: ROLE_LABELS[role as keyof typeof ROLE_LABELS] },
    { headers: { "Cache-Control": "no-store" } }
  );
  writeSession(response, result.session);
  return response;
}
