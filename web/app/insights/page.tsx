import { redirect } from "next/navigation";
import { fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";

/**
 * `/insights` has no content of its own — it is the section, and the sidebar
 * links to it. Overview is the landing panel: it is the first tab, and revenue
 * is the figure a reader opens a dashboard for — for every role that may see
 * it; the contact team lands on Fulfilment instead. The sidebar's link names
 * the shop it shows (`?shop=`), and the landing panel keeps it.
 */
export default async function InsightsIndexPage({ searchParams }: { searchParams?: { shop?: string } }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/insights");
  const landing = fallbackPath(session.role);
  const shop = typeof searchParams?.shop === "string" ? searchParams.shop : "";
  redirect(shop && landing.startsWith("/insights/") ? `${landing}?shop=${encodeURIComponent(shop)}` : landing);
}
