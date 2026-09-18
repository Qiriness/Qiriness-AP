import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell/AppShell";
import { ChatView } from "@/components/chat/ChatView";
import { getSession } from "@/lib/server/auth";
import { chatReadiness, listConversations } from "@/lib/server/chat-service";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import type { ChatConversationSummary } from "@/lib/chat-types";
import { canUseManagementChat, fallbackPath } from "../../../scripts/lib/dashboard-auth.mjs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Home · Qiriness Support OS" };

/**
 * Home — the management chat (beta). Management and Developer only.
 *
 * The middleware already refuses the contact role; this re-checks, as every
 * page guard here does, rather than trusting that it ran.
 */
export default async function HomePage() {
  const user = await getSession();
  if (!user) redirect("/login?next=/home");
  if (!canUseManagementChat(user.role)) redirect(fallbackPath(user.role));

  // Started, not awaited: the badges are read beside this page's own data
  // rather than before it. navBadgeCounts never throws.
  const badgesRead = navBadgeCounts();
  const readiness = chatReadiness();
  let conversations: ChatConversationSummary[] = [];
  let loadError: string | null = null;
  try {
    conversations = await listConversations(user);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load your conversations.";
  }

  const badges = await badgesRead;
  return (
    <AppShell activeHref="/home" {...badges}>
      <ChatView initialConversations={conversations} readiness={readiness} loadError={loadError} />
    </AppShell>
  );
}
