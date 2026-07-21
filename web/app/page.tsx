import { redirect } from "next/navigation";

/** The dashboard's first (and currently only) surface is Agent Setup. */
export default function HomePage() {
  redirect("/agent-setup");
}
