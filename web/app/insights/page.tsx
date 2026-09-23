import { redirect } from "next/navigation";
import { fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";

/**
 * `/insights` has no content of its own — it is the section, and the sidebar
 * links to it. Overview is the landing panel: it is the first tab, and revenue
 * is the figure a reader opens a dashboard for — for every role that may see
 * it; the contact team lands on Fulfilment instead.
 */
export default async function InsightsIndexPage() {
  const session = await getSession();
  redirect(session ? fallbackPath(session.role) : "/login?next=/insights");
}
