"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { UserMenu, type Me } from "./UserMenu";
import { HelpIcon } from "@/components/icons";
import styles from "./AppShell.module.css";

interface AppShellProps {
  activeHref: string;
  children: ReactNode;
  /** Open-conversation count for the sidebar badge; pages that know it pass it. */
  openConversations?: number;
}

function toLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export function AppShell({ activeHref, children, openConversations }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  // Who is signed in, asked once per page load and shared: the user menu shows
  // it, and the sidebar needs the role to decide whether Home is drawn. A 401
  // here is what ends a session whose account was disabled or re-roled since
  // sign-in.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return toLogin();
        if (response.ok && !cancelled) setMe(await response.json());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
          role={me?.role ?? null}
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
            <UserMenu me={me} />
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
