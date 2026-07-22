"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons";
import styles from "./CollapsibleSection.module.css";

interface CollapsibleSectionProps {
  title: string;
  /** Short trailing status, e.g. "3 of 6 started" or an article count. */
  meta?: string;
  /** Uncontrolled unless provided — lets a parent force-collapse (e.g. "complete") while still letting the user override. */
  defaultCollapsed?: boolean;
  children: ReactNode;
}

/**
 * Generic collapsible group used for the Core setup checklist and per-category
 * article groups. `defaultCollapsed` can change after mount (e.g. Core setup
 * completing mid-session) and the section follows it — but once the user
 * manually toggles, their choice wins over further `defaultCollapsed` changes.
 */
export function CollapsibleSection({ title, meta, defaultCollapsed = false, children }: CollapsibleSectionProps) {
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const collapsed = manualCollapsed ?? defaultCollapsed;

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setManualCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <ChevronDownIcon size={15} className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`} />
        <span className={styles.title}>{title}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </button>
      {!collapsed && <div className={styles.body}>{children}</div>}
    </div>
  );
}
