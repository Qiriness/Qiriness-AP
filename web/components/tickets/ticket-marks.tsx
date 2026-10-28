"use client";

/**
 * The small marks the ticket workspace repeats in three places — queue card,
 * compact rail, ticket header: the category's colour and icon, the priority
 * dot, and the status icons (needs a human, waiting on the customer, forwarded,
 * snoozed, VIP, linked threads). One file so the three cannot disagree.
 *
 * The colours are CSS tokens (`--cat-<key>` in globals.css); this only says
 * which token a category uses.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  AlertIcon,
  BoxIcon,
  BriefcaseIcon,
  BuildingIcon,
  CardIcon,
  ClockIcon,
  CrownIcon,
  FlaskIcon,
  ForwardIcon,
  HandshakeIcon,
  HelpIcon,
  HourglassIcon,
  LinkIcon,
  OrdersIcon,
  ReturnIcon,
  ShieldIcon,
  SparkleIcon,
  TagIcon,
  TruckIcon,
  UserIcon,
} from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import { formatTicketNumber } from "@/lib/types";
import type { KnowledgeCategory, TicketListItem, TicketPriorityBand } from "@/lib/types";
import { isSnoozed } from "@/lib/snooze";
import styles from "./TicketMarks.module.css";

type Icon = (props: { size?: number }) => ReactNode;

/** One icon per subject of the fixed taxonomy; `HelpIcon` for an uncategorised ticket. */
export const CATEGORY_ICONS: Record<KnowledgeCategory, Icon> = {
  order: OrdersIcon,
  delivery: TruckIcon,
  return_exchange: ReturnIcon,
  product: SparkleIcon,
  product_stock: BoxIcon,
  payment: CardIcon,
  account: UserIcon,
  promotions: TagIcon,
  cosmetovigilance: FlaskIcon,
  legal_privacy: ShieldIcon,
  b2b: BuildingIcon,
  partner_collaboration: HandshakeIcon,
  careers: BriefcaseIcon,
  other: HelpIcon,
  // Knowledge-only subjects: a ticket never carries them, but the type allows it.
  faq: HelpIcon,
  brand_story: SparkleIcon,
} as Record<KnowledgeCategory, Icon>;

/** `--cat-color` and `--cat-bg` for an element styled by category. */
export function categoryVars(category: KnowledgeCategory | null): CSSProperties {
  const key = category && category !== "faq" && category !== "brand_story" ? category : "other";
  return { "--cat-color": `var(--cat-${key})`, "--cat-bg": `var(--cat-${key}-050)` } as CSSProperties;
}

export function CategoryIcon({ category, size = 14 }: { category: KnowledgeCategory | null; size?: number }) {
  const Glyph = (category && CATEGORY_ICONS[category]) || HelpIcon;
  return <Glyph size={size} />;
}

/** The band in words, plus « set by a person » when someone pinned it in « Edit case ». */
export function priorityTitle(ticket: TicketListItem, t: ReturnType<typeof useT>): string {
  const band = t(`tickets.view.priority.${ticket.priorityBand}`);
  const label = t("tickets.panels.marks.priority", { band });
  return ticket.overrides.priority ? `${label} · ${t("tickets.panels.marks.pinned")}` : label;
}

/** Red, amber or green. The score that ranks the queue is no longer shown; the band is. */
export function PriorityDot({ band, title }: { band: TicketPriorityBand; title: string }) {
  return (
    <span className={`${styles.priorityDot} ${styles[`dot_${band}`]}`} title={title} role="img" aria-label={title} />
  );
}

/** « T-1042 », or nothing for a row from before the numbers existed. */
export function TicketNumber({ ticket, className }: { ticket: TicketListItem; className?: string }) {
  const label = formatTicketNumber(ticket.ticketNumber);
  return label ? <span className={className}>{label}</span> : null;
}

type StatusMark = { key: string; icon: Icon; tone: "warning" | "info" | "neutral" | "gold" | "teal"; label: string };

/**
 * What a reviewer scans the queue for, as icons with their meaning in the
 * tooltip and the accessible name. Order is fixed so a column of cards lines up.
 */
export function statusMarks(ticket: TicketListItem, t: ReturnType<typeof useT>): StatusMark[] {
  const marks: StatusMark[] = [];
  if (ticket.status === "awaiting_human" || ticket.level === 3 || ticket.level === 4) {
    const level = ticket.level ? ` · L${ticket.level} ${t(`levelMeaning.${ticket.level}`)}` : "";
    marks.push({
      key: "human",
      icon: ticket.level === 4 ? AlertIcon : UserIcon,
      tone: "warning",
      label: `${t("tickets.panels.marks.needsHuman")}${level}`,
    });
  }
  if (ticket.status === "awaiting_customer") {
    marks.push({ key: "customer", icon: HourglassIcon, tone: "info", label: t("tickets.panels.marks.needsCustomer") });
  }
  if (ticket.forwarding) {
    const to = ticket.forwarding.destination ? ` · ${ticket.forwarding.destination}` : "";
    marks.push({ key: "forwarded", icon: ForwardIcon, tone: "neutral", label: `${t("tickets.panels.marks.forwarded")}${to}` });
  }
  if (isSnoozed(ticket)) {
    marks.push({ key: "snoozed", icon: ClockIcon, tone: "neutral", label: t("tickets.panels.marks.snoozed") });
  }
  if (ticket.caseThreadCount > 1) {
    marks.push({
      key: "linked",
      icon: LinkIcon,
      tone: "teal",
      label: t("tickets.panels.marks.linked", { count: ticket.caseThreadCount }),
    });
  }
  if (ticket.isVip) {
    marks.push({ key: "vip", icon: CrownIcon, tone: "gold", label: t("tickets.panels.vip") });
  }
  return marks;
}

export function StatusIcons({ ticket, size = 14 }: { ticket: TicketListItem; size?: number }) {
  const t = useT();
  const marks = statusMarks(ticket, t);
  if (marks.length === 0) return null;
  return (
    <span className={styles.statusIcons}>
      {marks.map(({ key, icon: Glyph, tone, label }) => (
        <span key={key} className={`${styles.statusIcon} ${styles[`tone_${tone}`]}`} title={label} role="img" aria-label={label}>
          <Glyph size={size} />
        </span>
      ))}
    </span>
  );
}
