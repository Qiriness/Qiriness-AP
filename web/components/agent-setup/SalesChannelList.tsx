"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { addSalesChannel, deleteSalesChannel, updateSalesChannel } from "@/lib/api/sales-channels";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import type { SalesChannelsView } from "@/lib/types";
import styles from "./SenderDirectory.module.css";

/**
 * The marketplaces the shop sells on (`sales_channels`).
 *
 * THE ORDERS COME FIRST, because a channel handle is not something anyone knows
 * by heart: « connect-dev-1 » is a marketplace only because its orders say so.
 * The table lists every handle the shop's orders carry, Shopify's own name for
 * it and how many orders, and what it counts as today. Clicking a handle adds it
 * to the form below.
 *
 * Shares the Senders screen's styles: both are a short list of facts about who
 * is who, edited in place.
 */

const split = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function SalesChannelList({ initial, loadError }: { initial: SalesChannelsView | null; loadError: string | null }) {
  const t = useT();
  const [view, setView] = useState<SalesChannelsView | null>(initial);
  const [label, setLabel] = useState("");
  const [handles, setHandles] = useState("");
  const [analyticsNames, setAnalyticsNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<SalesChannelsView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
      return true;
    } catch (cause) {
      setError(knowledgeErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError || !view) {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t("setup.tabs.salesChannels.label")}</h2>
        <p className={styles.error} role="alert">{loadError ?? t("setup.salesChannels.loadFailed")}</p>
      </section>
    );
  }

  const addHandle = (handle: string) => {
    const current = split(handles);
    if (!current.includes(handle)) setHandles([...current, handle].join(", "));
  };

  return (
    <section className={styles.section} aria-labelledby="sales-channels-heading">
      <header className={styles.header}>
        <h2 className={styles.title} id="sales-channels-heading">{t("setup.tabs.salesChannels.label")}</h2>
        <p className={styles.intro}>{t("setup.salesChannels.intro")}</p>
      </header>

      <h3 className={styles.title}>{t("setup.salesChannels.observed")}</h3>
      <ul className={styles.list} aria-label={t("setup.salesChannels.observed")}>
        {view.observedHandles.map((row) => (
          <li key={row.handle} className={styles.row}>
            <span className={styles.pattern}>
              <button type="button" className={styles.select} disabled={busy || Boolean(row.marketplace)} onClick={() => addHandle(row.handle)}>
                {row.handle}
              </button>
              <span className={styles.kind}>
                {t("setup.salesChannels.shopifyLabel")}: {row.shopifyLabel ?? "—"} · {t("setup.salesChannels.orders")}: {row.orders}
              </span>
            </span>
            <span className={styles.meaning}>
              {t("setup.salesChannels.belongsTo")}: {row.marketplace ?? t("setup.salesChannels.ownStore")}
            </span>
          </li>
        ))}
      </ul>

      <form
        className={styles.addForm}
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run(() => addSalesChannel({ label, handles: split(handles), analyticsNames: split(analyticsNames) }))) {
            setLabel("");
            setHandles("");
            setAnalyticsNames("");
          }
        }}
      >
        <label className={styles.field}>
          {t("setup.salesChannels.name")}
          <input className={styles.input} value={label} placeholder="Amazon" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className={styles.field}>
          {t("setup.salesChannels.handles")}
          <input className={styles.input} value={handles} spellCheck={false} onChange={(e) => setHandles(e.target.value)} />
        </label>
        <label className={styles.field}>
          {t("setup.salesChannels.analyticsNames")}
          <input className={styles.input} value={analyticsNames} spellCheck={false} onChange={(e) => setAnalyticsNames(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !label.trim() || split(handles).length === 0}>
          {t("setup.salesChannels.add")}
        </Button>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}

      {view.channels.length === 0 ? (
        <p className={styles.intro}>{t("setup.salesChannels.none")}</p>
      ) : (
        <ul className={styles.list} aria-label={t("setup.tabs.salesChannels.label")}>
          {view.channels.map((channel) => (
            <li key={channel.id} className={styles.row}>
              <input
                className={styles.input}
                aria-label={t("setup.salesChannels.name")}
                defaultValue={channel.label}
                disabled={busy}
                onBlur={(e) => e.target.value.trim() !== channel.label && run(() => updateSalesChannel(channel.id, { label: e.target.value }))}
              />
              <input
                className={styles.input}
                aria-label={t("setup.salesChannels.handles")}
                defaultValue={channel.handles.join(", ")}
                spellCheck={false}
                disabled={busy}
                onBlur={(e) =>
                  e.target.value !== channel.handles.join(", ") &&
                  run(() => updateSalesChannel(channel.id, { handles: split(e.target.value) }))
                }
              />
              <input
                className={styles.input}
                aria-label={t("setup.salesChannels.analyticsNames")}
                defaultValue={channel.analyticsNames.join(", ")}
                spellCheck={false}
                disabled={busy}
                onBlur={(e) =>
                  e.target.value !== channel.analyticsNames.join(", ") &&
                  run(() => updateSalesChannel(channel.id, { analyticsNames: split(e.target.value) }))
                }
              />
              <Button size="sm" variant="tertiary" disabled={busy} onClick={() => run(() => deleteSalesChannel(channel.id))}>
                {t("setup.salesChannels.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
