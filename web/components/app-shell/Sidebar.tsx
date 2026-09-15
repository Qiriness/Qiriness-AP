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
  OrdersIcon,
  SettingsIcon,
  StoreIcon,
  TicketIcon,
} from "@/components/icons";
import { TEAM_MEMBER } from "@/lib/demo-data";
import { canUseManagementChat } from "../../../scripts/lib/dashboard-auth.mjs";
import styles from "./Sidebar.module.css";

interface NavItem {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number }>;
  available: boolean;
  /** A chip beside the label, e.g. "Beta". */
  chip?: string;
  /** Drawn only for roles this admits. Absent means every role. */
  visibleTo?: (role: string | null) => boolean;
}

const NAV: NavItem[] = [
  // The management chat. Hidden until the role is known, so the contact team
  // never sees a link that would only redirect them.
  {
    label: "Home",
    href: "/home",
    icon: HomeIcon,
    available: true,
    chip: "Beta",
    visibleTo: (role) => canUseManagementChat(role),
  },
  // Points at the section, not at a panel. `isActive` is an exact match, so
  // every page under /insights passes "/insights" as its activeHref and the
  // panel tabs inside handle the rest.
  { label: "Insights", href: "/insights", icon: InsightsIcon, available: true },
  { label: "Tickets", href: "/tickets", icon: TicketIcon, available: true },
  // `/orders/[id]` passes "/orders" as its activeHref, as Insights does.
  { label: "Orders", href: "/orders", icon: OrdersIcon, available: true },
  { label: "Agent Setup", href: "/agent-setup", icon: AgentIcon, available: true },
  { label: "Conversations", href: "/conversations", icon: ChatIcon, available: true },
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
  /** How many Tickets are not closed or resolved. Zero renders nothing. */
  openTickets?: number;
  /** The signed-in role, or null while it is still being fetched. */
  role?: string | null;
}

export function Sidebar({
  activeHref,
  collapsed,
  onToggleCollapse,
  onNavigate,
  openConversations = 0,
  openTickets = 0,
  role = null,
}: SidebarProps) {
  // Tickets is the queue to work, so it gets the warning colour; Conversations is
  // grey, present but not competing with it.
  const badges: Record<string, { count: number; noun: string; muted: boolean }> = {
    "/tickets": { count: openTickets, noun: "ticket", muted: false },
    "/conversations": { count: openConversations, noun: "conversation", muted: true },
  };

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
        {NAV.filter((item) => !item.visibleTo || item.visibleTo(role)).map((item) => {
          const Icon = item.icon;
          const isActive = item.available && item.href === activeHref;
          const badge = badges[item.href];

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
                {!collapsed && item.chip && <span className={styles.chip}>{item.chip}</span>}
                {/* Hidden on the collapsed rail, with the label and chip: the
                    rail is icons only, and a number there crowds the icon. */}
                {!collapsed && badge && badge.count > 0 && (
                  <span
                    className={`${styles.badge} ${badge.muted ? styles.badgeMuted : ""}`}
                    title={`${badge.count} ${badge.noun}${badge.count === 1 ? "" : "s"} still open`}
                  >
                    {badge.count}
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
