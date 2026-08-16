import { redirect } from "next/navigation";

/**
 * `/insights` has no content of its own — it is the section, and the sidebar
 * links to it. Fulfilment is the landing panel because it is the only one whose
 * figures are complete today: every order carries the timestamps it needs, so
 * it is the panel least likely to greet a first-time reader with a caveat.
 */
export default function InsightsIndexPage() {
  redirect("/insights/fulfilment");
}
