"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import {
  AgentIcon,
  ChatIcon,
  CollapseIcon,
  ExternalLinkIcon,
  HomeIcon,
  InsightsIcon,
  KnowledgeIcon,
  SettingsIcon,
  StoreIcon,
  TicketIcon,
} from "@/components/icons";
import { TEAM_MEMBER } from "@/lib/demo-data";
import styles from "./Sidebar.module.css";

interface NavItem {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number }>;
  available: boolean;
}

const NAV: NavItem[] = [
  { label: "Home", href: "#", icon: HomeIcon, available: false },
  { label: "Conversations", href: "/conversations", icon: ChatIcon, available: true },
  { label: "Tickets", href: "/tickets", icon: TicketIcon, available: true },
  // Points at the section, not at a panel. `isActive` is an exact match, so
  // every page under /insights passes "/insights" as its activeHref and the
  // panel tabs inside handle the rest.
  { label: "Insights", href: "/insights", icon: InsightsIcon, available: true },
  { label: "Knowledge", href: "#", icon: KnowledgeIcon, available: false },
  { label: "Agent Setup", href: "/agent-setup", icon: AgentIcon, available: true },
  { label: "Settings", href: "/settings", icon: SettingsIcon, available: true },
];

interface SidebarProps {
  activeHref: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** On mobile the sidebar is a slide-over; this closes it after navigation. */
  onNavigate?: () => void;
  /**
   * How many Conversations still need somebody, rendered as a badge.
   *
   * THE MITIGATION FOR ROUTING THEM OFF THE TICKETS QUEUE. Those threads used to
   * sit in the queue where they could not be missed; they now have a page of
   * their own, and the documented failure of that arrangement was three L3
   * threads awaiting a human behind a nav item nobody opened. A count on the nav
   * is how the page asks to be opened. Zero renders nothing.
   */
  openConversations?: number;
}

export function Sidebar({
  activeHref,
  collapsed,
  onToggleCollapse,
  onNavigate,
  openConversations = 0,
}: SidebarProps) {
  return (
    <nav
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}
      aria-label="Primary"
    >
      <div className={styles.brand}>
        <span className={styles.wordmark}>Qiriness</span>
        {!collapsed && <span className={styles.brandSub}>Support&nbsp;OS</span>}
      </div>

      <ul className={styles.navList}>
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = item.available && item.href === activeHref;

          if (!item.available) {
            return (
              <li key={item.label}>
                <span
                  className={styles.navItem}
                  aria-disabled="true"
                  title="Available soon"
                >
                  <Icon size={19} />
                  {!collapsed && (
                    <>
                      <span className={styles.navLabel}>{item.label}</span>
                      <span className={styles.soon}>Soon</span>
                    </>
                  )}
                </span>
              </li>
            );
          }

          return (
            <li key={item.label}>
              <Link
                href={item.href}
                className={`${styles.navItem} ${styles.navLink} ${
                  isActive ? styles.active : ""
                }`}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
              >
                <Icon size={19} />
                {!collapsed && <span className={styles.navLabel}>{item.label}</span>}
                {item.href === "/conversations" && openConversations > 0 && (
                  <span
                    className={styles.badge}
                    // Readable when collapsed too, where the number is all there is.
                    title={`${openConversations} conversation${openConversations === 1 ? "" : "s"} still open`}
                  >
                    {openConversations}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className={styles.footer}>
        <a
          className={styles.store}
          href="https://qiriness.com"
          target="_blank"
          rel="noreferrer noopener"
          title="Open the Qiriness store"
        >
          <span className={styles.storeIcon}>
            <StoreIcon size={18} />
          </span>
          {!collapsed && (
            <span className={styles.storeText}>
              <span className={styles.storeName}>{TEAM_MEMBER.store}</span>
              <span className={styles.storeMeta}>Shopify store</span>
            </span>
          )}
          {!collapsed && <ExternalLinkIcon size={15} className={styles.storeExternal} />}
        </a>

        <button
          type="button"
          className={styles.collapseBtn}
          onClick={onToggleCollapse}
          aria-pressed={collapsed}
        >
          <CollapseIcon size={18} className={collapsed ? styles.flip : ""} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
