"use client";

import type { ReactNode } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import type { OrganicView, SocialConnectionsStatus, SocialKind, SocialMode } from "@/lib/social-types";
import { Button } from "../ui/Button";
import { useInsightsFrame } from "./InsightsFrame";
import { Segmented } from "./Segmented";
import { SocialConnectionsDialog } from "./SocialConnectionsDialog";
import styles from "./SocialView.module.css";

/**
 * The panel's own controls, under the shared range bar: which network, organic
 * or paid, which view of one account, and the Connections dialog. All of it is
 * URL state (`?mode=`, `?network=`, `?view=`, `?connections=1`), so a view is
 * linkable like every other panel and the server renders it.
 */
export function SocialHeader({
  mode,
  network,
  view,
  kinds,
  connections,
  openConnections,
  connected,
  connectError,
  connectProvider,
}: {
  mode: SocialMode;
  network: string;
  view: OrganicView;
  kinds: SocialKind[];
  connections: SocialConnectionsStatus;
  openConnections: boolean;
  connected: string | null;
  connectError: string | null;
  connectProvider: string | null;
}) {
  const t = useT();
  const fmt = useFormat();
  const { navigate } = useInsightsFrame();

  const title =
    network === "all" ? t(mode === "organic" ? "insights.social.title.organicAll" : "insights.social.title.paidAll") : t(`insights.social.kind.${network}`);
  const subtitle =
    network === "all" ? t(mode === "organic" ? "insights.social.subtitle.organicAll" : "insights.social.subtitle.paidAll") : t(`insights.social.subtitle.${network}`);

  return (
    <>
      <div className={styles.statusRow}>
        {connections.providers.map((p) => (
          <span key={p.provider} className={styles.statusPill}>
            <i className={styles[`dot_${tone(p)}`]} aria-hidden="true" />
            {t(`insights.social.provider.${p.provider}`)}{" "}
            {!p.connected
              ? t("insights.social.status.notConnected")
              : p.lastSyncStatus === "needs_reconnect"
                ? t("insights.social.status.reconnect")
                : p.syncQueued && !p.lastSyncAt
                  ? t("insights.social.status.firstSync")
                  : p.lastSyncAt
                    ? t("insights.social.status.synced", { ago: fmt.age(p.lastSyncAt) })
                    : t("insights.social.status.queued")}
          </span>
        ))}
      </div>

      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
        <div className={styles.controls}>
          <label className={styles.networkLabel}>
            {t("insights.social.network")}
            <select
              className={styles.select}
              value={network}
              onChange={(e) => navigate({ network: e.target.value === "all" ? null : e.target.value, view: null })}
            >
              <option value="all">{t("insights.social.allNetworks")}</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`insights.social.kind.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <Segmented
            options={[
              { id: "organic" as SocialMode, label: t("insights.social.mode.organic") },
              { id: "paid" as SocialMode, label: t("insights.social.mode.paid") },
            ]}
            value={mode}
            onChange={(next) => navigate({ mode: next === "organic" ? null : next, network: null, view: null })}
            label={t("insights.social.mode.label")}
          />
          <Button onClick={() => navigate({ connections: "1" })}>{t("insights.social.connections.open")}</Button>
        </div>
      </div>

      {mode === "organic" && network !== "all" ? (
        <div className={styles.subtabs}>
          <Segmented
            options={(["profile", "content", "posts"] as OrganicView[]).map((id) => ({ id, label: t(`insights.social.view.${id}`) }))}
            value={view}
            onChange={(next) => navigate({ view: next === "profile" ? null : next })}
            label={t("insights.social.view.label")}
          />
        </div>
      ) : null}

      {openConnections ? (
        <SocialConnectionsDialog
          initial={connections}
          returnKey="social"
          notice={connected ? { ok: true, provider: connected } : connectError ? { ok: false, code: connectError, provider: connectProvider } : null}
          onClose={() => navigate({ connections: null, connected: null, connect_error: null, provider: null })}
        />
      ) : null}
    </>
  );
}

function tone(p: SocialConnectionsStatus["providers"][number]): "ok" | "warn" | "off" {
  if (!p.connected) return "off";
  if (p.lastSyncStatus === "failed" || p.lastSyncStatus === "needs_reconnect") return "warn";
  return "ok";
}

/** Shown in place of the panel when nothing of this kind is connected yet. */
export function ConnectPrompt({ kind }: { kind: "organic" | "paid" }) {
  const t = useT();
  const { navigate } = useInsightsFrame();
  return (
    <section className={styles.prompt}>
      <h2>{t(`insights.social.prompt.${kind}.title`)}</h2>
      <p>{t(`insights.social.prompt.${kind}.body`)}</p>
      <Button variant="primary" onClick={() => navigate({ connections: "1" })}>
        {t("insights.social.connections.open")}
      </Button>
    </section>
  );
}

/** A platform card that opens that network's own view. */
export function PlatformCardLink({ kind, label, children }: { kind: string; label: string; children: ReactNode }) {
  const t = useT();
  const { navigate } = useInsightsFrame();
  return (
    <button type="button" className={styles.platformCard} onClick={() => navigate({ network: kind, view: null })} aria-label={t("insights.social.platforms.open", { name: label })}>
      <span className={styles.platformTop}>
        <span className={styles.platformId}>
          <span className={styles.platformIcon} aria-hidden="true">
            {label.slice(0, 2).toUpperCase()}
          </span>
          {label}
        </span>
        <span aria-hidden="true">↗</span>
      </span>
      {children}
    </button>
  );
}
