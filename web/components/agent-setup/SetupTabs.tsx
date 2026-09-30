"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useT } from "@/lib/i18n/client";

import styles from "./SetupTabs.module.css";

/**
 * Navigation across the six places setting the agent up happens.
 *
 * TABS RATHER THAN BUTTONS, and the distinction is not cosmetic: a button reads
 * as an action taken from where you are, and these are places of equal standing.
 * Knowledge is what the agent knows, the rulebook is what it does, the
 * parameters are the numbers both of those quote, the promotions are which live
 * codes a reply may hand out, the collections are which groups of products the
 * agent may advise from at all, the recommendations are which products it may
 * put forward inside them, and forwarding is who receives the mail it will not
 * answer. None is a detour from another.
 *
 * COLLECTIONS SITS BEFORE RECOMMENDATIONS because it is the wider decision and
 * the earlier one: a collection nobody switched on cannot be advised from,
 * whatever is ticked inside it.
 *
 * "Test the agent" stays a button on the knowledge screen, because it IS an
 * action — it opens a dialog and goes nowhere.
 */
// Words: `setup.tabs.<id>.label` and `.hint`.
const TABS = [
  { href: "/agent-setup", id: "knowledge" },
  { href: "/agent-setup/rules", id: "rules" },
  { href: "/agent-setup/parameters", id: "parameters" },
  { href: "/agent-setup/promotions", id: "promotions" },
  { href: "/agent-setup/collections", id: "collections" },
  { href: "/agent-setup/recommendations", id: "recommendations" },
  { href: "/agent-setup/forwarding", id: "forwarding" },
  { href: "/agent-setup/senders", id: "senders" },
];

export function SetupTabs() {
  const t = useT();
  const pathname = usePathname();

  return (
    <nav className={styles.tabs} aria-label={t("nav.agentSetup")}>
      {TABS.map((tab) => {
        // EXACT MATCH, not `startsWith`. /agent-setup is a prefix of both other
        // routes, so a prefix test would light every tab at once on the
        // rulebook — the failure that makes a tab bar useless.
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={styles.tab}
            aria-current={active ? "page" : undefined}
            data-active={active || undefined}
          >
            <span className={styles.label}>{t(`setup.tabs.${tab.id}.label`)}</span>
            <span className={styles.hint}>{t(`setup.tabs.${tab.id}.hint`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
