"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons";
import styles from "./TicketSection.module.css";

interface TicketSectionProps {
  title: string;
  /** Row count shown in the header, so a collapsed section still reports its size. */
  count: number;
  /** One line saying what is in here — these three sections are easy to confuse. */
  description: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}

/**
 * A page-level collapsible table section.
 *
 * Not agent-setup's CollapsibleSection: that one is a compact sidebar group
 * with no room for a description, and giving one component both jobs would need
 * variants that help neither caller.
 *
 * The count lives in the header rather than only in the table, so a collapsed
 * section still says how much it is hiding — which is the whole point of being
 * able to collapse it.
 */
export function TicketSection({
  title,
  count,
  description,
  defaultCollapsed = false,
  children,
}: TicketSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <ChevronDownIcon
          size={16}
          className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`}
        />
        <span className={styles.title}>{title}</span>
        <span className={styles.count}>{count.toLocaleString()}</span>
        <span className={styles.description}>{description}</span>
      </button>

      {!collapsed && <div className={styles.body}>{children}</div>}
    </section>
  );
}
