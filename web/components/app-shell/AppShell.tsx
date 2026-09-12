"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { UserMenu } from "./UserMenu";
import { HelpIcon } from "@/components/icons";
import styles from "./AppShell.module.css";

interface AppShellProps {
  activeHref: string;
  children: ReactNode;
  /** Open-conversation count for the sidebar badge; pages that know it pass it. */
  openConversations?: number;
}

export function AppShell({ activeHref, children, openConversations }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebarSlot} ${drawerOpen ? styles.drawerOpen : ""}`}>
        <Sidebar
          activeHref={activeHref}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onNavigate={() => setDrawerOpen(false)}
          openConversations={openConversations}
        />
      </aside>

      {drawerOpen && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuBtn}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>

          <span className={styles.topbarBrand}>Qiriness</span>

          <div className={styles.topbarActions}>
            <button type="button" className={styles.helpBtn}>
              <HelpIcon size={17} />
              <span className={styles.helpLabel}>Help</span>
            </button>
            <UserMenu />
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
