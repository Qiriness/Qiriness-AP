"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon, SearchIcon } from "@/components/icons";
import styles from "./TicketSection.module.css";

/** Each section searches its own table; see the note on the component. */
interface TicketSectionSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Names the table being searched, since four of these share a page. */
  label: string;
}

interface TicketSectionProps {
  title: string;
  /** Row count shown in the header, so a collapsed section still reports its size. */
  count: number;
  /** One line saying what is in here — these three sections are easy to confuse. */
  description: string;
  defaultCollapsed?: boolean;
  /** Omit for a section with nothing worth searching. */
  search?: TicketSectionSearch;
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
 *
 * SEARCH BELONGS TO THE TABLE, NOT THE PAGE. One box above four tables meant
 * typing a requester's name silently re-cut every section at once, and the
 * result you wanted was as likely to be in a collapsed one. Each section now
 * searches only itself, in its own header.
 *
 * IT APPEARS ONLY WHEN THE SECTION IS OPEN. A box that filters rows nobody can
 * see is a control with no feedback, and it would crowd the four collapsed
 * headers that exist to be scanned rather than used.
 *
 * THE HEADER IS NO LONGER ONE BUTTON. An input cannot live inside a `button` —
 * invalid, and every keystroke would toggle the section. So the button now
 * covers the chevron, title, count and description, and the search sits beside
 * it as a sibling; the row keeps its old look because the border and background
 * moved up to the container.
 */
export function TicketSection({
  title,
  count,
  description,
  defaultCollapsed = false,
  search,
  children,
}: TicketSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();

  return (
    <section className={styles.section}>
      <div className={`${styles.header} ${collapsed ? "" : styles.headerOpen}`}>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
        >
          <ChevronDownIcon
            size={16}
            className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`}
          />
          <span className={styles.title}>{title}</span>
          <span className={styles.count}>{count.toLocaleString()}</span>
          <span className={styles.description}>{description}</span>
        </button>

        {search && !collapsed && (
          <div className={styles.searchWrap}>
            <SearchIcon size={15} />
            <input
              type="search"
              className={styles.searchInput}
              placeholder={search.placeholder}
              aria-label={search.label}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
            />
          </div>
        )}
      </div>

      {!collapsed && (
        <div className={styles.body} id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
