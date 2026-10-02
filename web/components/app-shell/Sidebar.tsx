"use client";

import Image from "next/image";
import Link from "next/link";
import type { MouseEvent } from "react";
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
import { shopLabel, useShop } from "@/lib/shop-context";
import { canUseManagementChat } from "../../../scripts/lib/dashboard-auth.mjs";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/en";
import styles from "./Sidebar.module.css";

interface NavItem {
  /** A `nav.*` key in the dictionary. */
  labelKey: MessageKey;
  href: string;
  icon: ComponentType<{ size?: number }>;
  available: boolean;
  /** A chip beside the label, e.g. "Beta". */
  chipKey?: MessageKey;
  /** Drawn only for roles this admits. Absent means every role. */
  visibleTo?: (role: string | null) => boolean;
}

const NAV: NavItem[] = [
  // The management chat. Hidden until the role is known, so the contact team
  // never sees a link that would only redirect them.
  {
    labelKey: "nav.home",
    href: "/home",
    icon: HomeIcon,
    available: true,
    chipKey: "nav.beta",
    visibleTo: (role) => canUseManagementChat(role),
  },
  // Points at the section, not at a panel. `isActive` is an exact match, so
  // every page under /insights passes "/insights" as its activeHref and the
  // panel tabs inside handle the rest.
  { labelKey: "nav.insights", href: "/insights", icon: InsightsIcon, available: true },
  { labelKey: "nav.tickets", href: "/tickets", icon: TicketIcon, available: true },
  // `/orders/[id]` passes "/orders" as its activeHref, as Insights does.
  { labelKey: "nav.orders", href: "/orders", icon: OrdersIcon, available: true },
  { labelKey: "nav.agentSetup", href: "/agent-setup", icon: AgentIcon, available: true },
  { labelKey: "nav.conversations", href: "/conversations", icon: ChatIcon, available: true },
  { labelKey: "nav.settings", href: "/settings", icon: SettingsIcon, available: true },
];

interface SidebarProps {
  activeHref: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /**
   * Called on a nav click, with the link's own event. The shell uses it to close
   * the mobile slide-over and to run the navigation itself, so the page can say
   * it is loading (see AppShell).
   */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string, label: string) => void;
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
  /**
   * How many orders are waiting to ship (`open_orders()`'s rule, so an order
   * refunded instead of shipped is not one). Zero renders nothing.
   */
  unfulfilledOrders?: number;
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
  unfulfilledOrders = 0,
  role = null,
}: SidebarProps) {
  const t = useT();
  // The shop's name and storefront, from `shops` (shop-context.tsx). Both were
  // literals: « Qiriness » and https://qiriness.com.
  const shop = useShop();
  // Tickets is the queue to work, so it gets the warning colour; Conversations and
  // Orders are grey, present but not competing with it.
  const badges: Record<string, { count: number; key: string; muted: boolean }> = {
    "/tickets": { count: openTickets, key: "badge.tickets", muted: false },
    "/conversations": { count: openConversations, key: "badge.conversations", muted: true },
    "/orders": { count: unfulfilledOrders, key: "badge.orders", muted: true },
  };

  return (
    <nav
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}
      aria-label={t("nav.primary")}
    >
      <div className={styles.brand}>
        <Image
          src="/brand/logo.png"
          alt={shopLabel(shop)}
          width={32}
          height={32}
          className={styles.mark}
          // 530 bytes and already the size it is shown at: the optimiser would
          // re-encode it for nothing and add a request through /_next/image.
          unoptimized
          priority
        />
        {!collapsed && <span className={styles.brandSub}>Support&nbsp;OS</span>}
      </div>

      <ul className={styles.navList}>
        {NAV.filter((item) => !item.visibleTo || item.visibleTo(role)).map((item) => {
          const Icon = item.icon;
          const isActive = item.available && item.href === activeHref;
          const badge = badges[item.href];

          if (!item.available) {
            return (
              <li key={item.labelKey}>
                <span
                  className={styles.navItem}
                  aria-disabled="true"
                  title={t("nav.availableSoon")}
                >
                  <Icon size={19} />
                  {!collapsed && (
                    <>
                      <span className={styles.navLabel}>{t(item.labelKey)}</span>
                      <span className={styles.soon}>{t("nav.soon")}</span>
                    </>
                  )}
                </span>
              </li>
            );
          }

          return (
            <li key={item.labelKey}>
              <Link
                href={item.href}
                className={`${styles.navItem} ${styles.navLink} ${
                  isActive ? styles.active : ""
                }`}
                aria-current={isActive ? "page" : undefined}
                onClick={(event) => onNavigate?.(event, item.href, t(item.labelKey))}
              >
                <Icon size={19} />
                {!collapsed && <span className={styles.navLabel}>{t(item.labelKey)}</span>}
                {!collapsed && item.chipKey && <span className={styles.chip}>{t(item.chipKey)}</span>}
                {/* Hidden on the collapsed rail, with the label and chip: the
                    rail is icons only, and a number there crowds the icon. */}
                {!collapsed && badge && badge.count > 0 && (
                  <span
                    className={`${styles.badge} ${badge.muted ? styles.badgeMuted : ""}`}
                    title={t(badge.key, { count: badge.count })}
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
          href={shop.storefrontUrl ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
          title={t("nav.openStore")}
        >
          <span className={styles.storeIcon}>
            <StoreIcon size={18} />
          </span>
          {!collapsed && (
            <span className={styles.storeText}>
              <span className={styles.storeName}>{shopLabel(shop)}</span>
              <span className={styles.storeMeta}>{t("nav.shopifyStore")}</span>
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
          {!collapsed && <span>{t("nav.collapse")}</span>}
        </button>
      </div>
    </nav>
  );
}
