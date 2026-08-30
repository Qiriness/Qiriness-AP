"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./SetupTabs.module.css";

/**
 * Navigation across the three halves of setting the agent up.
 *
 * TABS RATHER THAN BUTTONS, and the distinction is not cosmetic: a button reads
 * as an action taken from where you are, and these are three places of equal
 * standing. Knowledge is what the agent knows, the rulebook is what it does, and
 * the parameters are the numbers both of those quote. None is a detour from
 * another.
 *
 * "Test the agent" stays a button on the knowledge screen, because it IS an
 * action — it opens a dialog and goes nowhere.
 */
const TABS = [
  { href: "/agent-setup", label: "Knowledge", hint: "what the agent knows" },
  { href: "/agent-setup/rules", label: "Rules", hint: "what it does about it" },
  { href: "/agent-setup/parameters", label: "Parameters", hint: "the numbers both quote" },
];

export function SetupTabs() {
  const pathname = usePathname();

  return (
    <nav className={styles.tabs} aria-label="Agent setup">
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
            <span className={styles.label}>{tab.label}</span>
            <span className={styles.hint}>{tab.hint}</span>
          </Link>
        );
      })}
    </nav>
  );
}
