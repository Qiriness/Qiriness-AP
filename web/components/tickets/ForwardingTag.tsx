"use client";

import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag } from "@/lib/i18n/locales";
import { formatWake } from "@/lib/snooze";
import type { TicketForwarding } from "@/lib/types";
import styles from "./ForwardingTag.module.css";

// The forwarding pass hands some tickets to a colleague (cosmétovigilance, RH…)
// and leaves them in the queue (DECISIONS.md § Forwarding). This says which, so
// nobody answers a ticket without knowing a colleague has it or is about to.

function className(forwarding: TicketForwarding, base: string) {
  return forwarding.state === "failed" ? `${base} ${styles.failed}` : base;
}

/** In a list row: where it goes, and whether it has gone. */
export function ForwardingChip({ forwarding }: { forwarding: TicketForwarding | null }) {
  const t = useT();
  if (!forwarding) return null;
  const destination = forwarding.destination ?? t("tickets.panels.forwarding.colleague");
  return (
    <span
      className={className(forwarding, styles.chip)}
      title={t(`tickets.panels.forwarding.title.${forwarding.state}`, { destination })}
    >
      {t(`tickets.panels.forwarding.row.${forwarding.state}`, { destination })}
    </span>
  );
}

/** On the ticket, under the header: the same, in a sentence. */
export function ForwardingBanner({ forwarding }: { forwarding: TicketForwarding }) {
  const t = useT();
  const locale = intlTag(useLocale());
  const destination = forwarding.destination ?? t("tickets.panels.forwarding.colleague");
  return (
    <p className={className(forwarding, styles.banner)} role="status">
      <strong>{t(`tickets.panels.forwarding.row.${forwarding.state}`, { destination })}</strong>
      <span>
        {forwarding.state === "forwarded" && forwarding.at
          ? t("tickets.panels.forwarding.sentAt", { when: formatWake(forwarding.at, locale) })
          : t(`tickets.panels.forwarding.title.${forwarding.state}`, { destination })}
      </span>
    </p>
  );
}
