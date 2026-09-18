"use client";

import { useEffect, useState, useTransition } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { UserMenu, type Me } from "./UserMenu";
import { HelpIcon } from "@/components/icons";
import styles from "./AppShell.module.css";

interface AppShellProps {
  activeHref: string;
  children: ReactNode;
  /** Open-conversation count for the sidebar badge; pages that know it pass it. */
  openConversations?: number;
  /** Open-ticket count for the sidebar badge. */
  openTickets?: number;
}

function toLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export function AppShell({ activeHref, children, openConversations, openTickets }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<{ href: string; label: string } | null>(null);

  // The target belongs to one navigation; it goes when that navigation ends.
  useEffect(() => {
    if (!pending) setTarget(null);
  }, [pending]);

  /**
   * A PAGE TAKES A MOMENT, SO THE CLICK SAYS SO — the Insights frame's rule,
   * applied to the whole app. Every page reads the database before it can
   * render, and a plain link shows nothing until the new page has arrived, so a
   * click read as a click that missed. Run in a transition instead: the clicked
   * item lights up at once, and the current page stays on screen, dimmed, under
   * "Loading …" until the new one replaces it.
   *
   * Not a `loading.tsx`: each page draws this shell itself, so a route skeleton
   * would drop the sidebar, and on Orders it would reset the search box on
   * every filter change.
   */
  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string, label: string) {
    setDrawerOpen(false);
    // A modified click (new tab, new window) belongs to the browser.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setTarget({ href, label });
    startTransition(() => router.push(href));
  }

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
          activeHref={target?.href ?? activeHref}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onNavigate={navigate}
          openConversations={openConversations}
          openTickets={openTickets}
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

        <div className={`${styles.content} ${pending ? styles.pending : ""}`} aria-busy={pending}>
          {children}
        </div>
        {pending && target ? (
          <div className={styles.loadingLayer}>
            <p className={styles.loadingPill} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              {`Loading ${target.label}…`}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
