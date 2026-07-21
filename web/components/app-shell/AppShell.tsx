"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { HelpIcon } from "@/components/icons";
import { TEAM_MEMBER } from "@/lib/demo-data";
import styles from "./AppShell.module.css";

interface AppShellProps {
  activeHref: string;
  children: ReactNode;
}

export function AppShell({ activeHref, children }: AppShellProps) {
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
            <div className={styles.user} title={TEAM_MEMBER.name}>
              <span className={styles.avatar}>{TEAM_MEMBER.initials}</span>
              <span className={styles.userName}>{TEAM_MEMBER.name}</span>
            </div>
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
