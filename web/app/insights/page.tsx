import { redirect } from "next/navigation";

/**
 * `/insights` has no content of its own — it is the section, and the sidebar
 * links to it. Sales is the landing panel: it is the first tab, and revenue is
 * the figure a reader opens a dashboard for.
 */
export default function InsightsIndexPage() {
  redirect("/insights/sales");
}
