"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./UserMenu.module.css";

export interface Me {
  email: string;
  displayName: string | null;
  role: string;
  roleLabel: string;
}

function initials(me: Me): string {
  const source = me.displayName?.trim() || me.email.split("@")[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The signed-in user, top right, with Sign out.
 *
 * `me` is fetched once by AppShell from `/api/auth/me` — that call is what ends
 * a session whose account was disabled or re-roled since sign-in — and shared
 * with the sidebar, which needs the role.
 */
export function UserMenu({ me }: { me: Me | null }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setLeaving(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  if (!me) return <span className={styles.placeholder} aria-hidden />;

  const name = me.displayName?.trim() || me.email;
  return (
    <div className={styles.root} ref={root}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar}>{initials(me)}</span>
        <span className={styles.identity}>
          <span className={styles.name}>{name}</span>
          <span className={styles.role}>{me.roleLabel}</span>
        </span>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHead}>
            <span className={styles.menuEmail}>{me.email}</span>
            <span className={styles.menuRole}>{me.roleLabel}</span>
          </div>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={signOut} disabled={leaving}>
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
