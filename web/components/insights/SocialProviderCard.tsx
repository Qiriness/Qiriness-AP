"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag, type Locale } from "@/lib/i18n/locales";
import type { ProviderStatus, SocialConnectionsStatus } from "@/lib/social-types";
import { Button } from "../ui/Button";
import styles from "./SocialView.module.css";

const BASE = "/api/settings/integrations";
const RECONNECT_WARN_DAYS = 7;

const when = (iso: string | null, locale: Locale) =>
  iso ? new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "medium", timeStyle: "short" }) : null;

/**
 * One card per provider, then the networks not built yet. Shared by the
 * panel's Connections dialog and Settings → Integrations, so the two can never
 * describe a connection differently.
 *
 * CONNECT IS A LINK, NOT A FETCH: the browser leaves for the provider's consent
 * screen and comes back to the callback. Everything else — tracking an
 * account, « Sync now », disconnecting — is a request, then a refresh of the
 * page behind so the panel follows.
 */
export function SocialProviderCards({ initial, returnKey }: { initial: SocialConnectionsStatus; returnKey: "social" | "settings" }) {
  const t = useT();
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(key: string, url: string, init: RequestInit) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t("insights.social.connections.failed", { status: response.status }));
        return;
      }
      setStatus(payload as SocialConnectionsStatus);
      router.refresh();
    } catch {
      setError(t("insights.social.connections.unreachable"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.providers}>
      {status.providers.map((p) => (
        <ProviderCard
          key={p.provider}
          status={p}
          returnKey={returnKey}
          busy={busy}
          onSync={() => call(`sync:${p.provider}`, `${BASE}/${p.provider}/sync`, { method: "POST" })}
          onDisconnect={() => call(`off:${p.provider}`, `${BASE}/${p.provider}`, { method: "DELETE" })}
          onTrack={(id, enabled) => call(`acc:${id}`, `${BASE}/social/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) })}
        />
      ))}
      {error ? (
        <p className={styles.noticeBad} role="alert">
          {error}
        </p>
      ) : null}
      <ul className={styles.upcoming}>
        {status.upcoming.map((network) => (
          <li key={network}>
            <span className={styles.platformIcon} aria-hidden="true">
              {t(`insights.social.network.${network}`).slice(0, 2).toUpperCase()}
            </span>
            <span>
              <strong>{t(`insights.social.network.${network}`)}</strong>
              <small>{t("insights.social.connections.notYet")}</small>
            </span>
            <span className={styles.soon}>{t("insights.social.connections.soon")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderCard({
  status: p,
  returnKey,
  busy,
  onSync,
  onDisconnect,
  onTrack,
}: {
  status: ProviderStatus;
  returnKey: string;
  busy: string | null;
  onSync: () => void;
  onDisconnect: () => void;
  onTrack: (id: string, enabled: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const connectHref = `${BASE}/${p.provider}/start?return=${returnKey}`;
  const expiresSoon =
    p.tokenExpiresAt !== null && Date.parse(p.tokenExpiresAt) - Date.now() < RECONNECT_WARN_DAYS * 24 * 3600 * 1000;
  const needsReconnect = p.lastSyncStatus === "needs_reconnect" || (p.tokenExpiresAt !== null && Date.parse(p.tokenExpiresAt) < Date.now());

  return (
    <section className={styles.provider}>
      <header className={styles.providerHead}>
        <span className={styles.platformIcon} aria-hidden="true">
          {p.provider === "meta" ? "M" : "G"}
        </span>
        <span className={styles.providerName}>
          <strong>{t(`insights.social.provider.${p.provider}`)}</strong>
          <small>{t(`insights.social.provider.${p.provider}.covers`)}</small>
        </span>
        <span className={p.connected && !needsReconnect ? styles.statusOk : styles.statusOff}>
          {!p.connected ? t("insights.social.status.notConnected") : needsReconnect ? t("insights.social.status.reconnect") : t("insights.social.status.connected")}
        </span>
      </header>

      {!p.configured ? (
        <p className={styles.providerNote}>{t("insights.social.connections.notConfigured", { vars: p.missing.join(", ") })}</p>
      ) : null}

      {p.connected ? (
        <>
          <dl className={styles.providerFacts}>
            <dt>{t("insights.social.connections.lastSync")}</dt>
            <dd>
              {p.lastSyncAt ? when(p.lastSyncAt, locale) : t("insights.social.connections.neverSynced")}
              {p.syncQueued ? <span className={styles.queued}> · {t("insights.social.status.queued")}</span> : null}
              {p.lastSyncStatus === "failed" ? <span className={styles.failed}> · {t("insights.social.status.failed")}</span> : null}
            </dd>
            {p.tokenExpiresAt ? (
              <>
                <dt>{t("insights.social.connections.expires")}</dt>
                <dd className={expiresSoon ? styles.failed : undefined}>{when(p.tokenExpiresAt, locale)}</dd>
              </>
            ) : null}
          </dl>
          {p.lastSyncError ? <p className={styles.providerError}>{p.lastSyncError}</p> : null}

          {p.accounts.length ? (
            <ul className={styles.accounts}>
              {p.accounts.map((a) => (
                <li key={a.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      disabled={busy !== null}
                      onChange={(e) => onTrack(a.id, e.target.checked)}
                    />
                    <span>
                      <strong>{a.name ?? a.handle ?? a.id}</strong>
                      <small>
                        {t(`insights.social.kind.${a.kind}`)}
                        {a.handle ? ` · @${a.handle}` : ""}
                        {a.currency ? ` · ${a.currency}` : ""}
                      </small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <div className={styles.providerActions}>
        {p.configured ? (
          <a className={styles.connectLink} href={connectHref}>
            {p.connected ? t("insights.social.connections.reconnect") : t("insights.social.connections.connect")}
          </a>
        ) : (
          <span className={styles.connectDisabled} title={t("insights.social.connections.notConfigured", { vars: p.missing.join(", ") })}>
            {t("insights.social.connections.connect")}
          </span>
        )}
        {p.connected ? (
          <>
            <Button onClick={onSync} loading={busy === `sync:${p.provider}`} disabled={busy !== null || p.syncQueued}>
              {p.syncQueued ? t("insights.social.status.queued") : t("insights.social.connections.syncNow")}
            </Button>
            <Button variant="danger" onClick={onDisconnect} loading={busy === `off:${p.provider}`} disabled={busy !== null}>
              {t("insights.social.connections.disconnect")}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
