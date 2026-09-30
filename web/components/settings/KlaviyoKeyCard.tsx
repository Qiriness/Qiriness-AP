"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useT } from "@/lib/i18n/client";
import { intlTag, type Locale } from "@/lib/i18n/locales";
import type { KlaviyoStatus } from "@/lib/server/integrations-service";
import { Button } from "../ui/Button";
import t from "../insights/tables.module.css";
import styles from "./KlaviyoKeyCard.module.css";

const ENDPOINT = "/api/settings/integrations/klaviyo";

const when = (iso: string | null, locale: Locale) =>
  iso ? new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "medium", timeStyle: "short" }) : null;

/**
 * Where the Klaviyo private key is pasted. The field is write-only: once saved
 * the key is shown as its last four characters and can be replaced or removed,
 * never read. The server checks it against Klaviyo before storing it, so a
 * typo is refused here rather than failing the next nightly.
 */
export function KlaviyoKeyCard({ status }: { status: KlaviyoStatus }) {
  const t2 = useT();
  const locale = useLocale();
  const router = useRouter();
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(!status.connected);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE") {
    setBusy(method === "PUT" ? "save" : "remove");
    setError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ key }) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t2("settings.klaviyo.failed", { status: response.status }));
        return;
      }
      setKey("");
      setEditing(method === "DELETE");
      router.refresh();
    } catch {
      setError(t2("settings.klaviyo.unreachable"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.card}>
      {status.connected ? (
        <dl className={styles.facts}>
          <dt>{t2("settings.klaviyo.privateKey")}</dt>
          <dd>
            <span className={styles.key}>pk_…{status.keyHint}</span>
            <span className={styles.connected}>{t2("settings.klaviyo.connected")}</span>
          </dd>
          <dt>{t2("settings.klaviyo.saved")}</dt>
          <dd>{when(status.savedAt, locale)}</dd>
          <dt>{t2("settings.klaviyo.lastSync")}</dt>
          <dd>
            {status.lastSyncAt ? (
              <>
                {when(status.lastSyncAt, locale)}{" "}
                <span className={status.lastSyncStatus === "failed" ? styles.failed : styles.ok}>
                  {status.lastSyncStatus === "failed" ? t2("settings.klaviyo.syncFailed") : "OK"}
                </span>
                {status.lastSyncError ? <span className={t.sub}>{status.lastSyncError}</span> : null}
              </>
            ) : (
              <span className={t.muted}>{t2("settings.klaviyo.notYet")}</span>
            )}
          </dd>
        </dl>
      ) : null}

      {editing ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void send("PUT");
          }}
        >
          <label className={styles.label} htmlFor="klaviyo-key">
            {status.connected ? t2("settings.klaviyo.replaceKey") : t2("settings.klaviyo.apiKey")}
          </label>
          <div className={styles.row}>
            <input
              id="klaviyo-key"
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="pk_…"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button type="submit" variant="primary" loading={busy === "save"} disabled={!key.trim() || busy !== null}>
              {t2("settings.klaviyo.checkSave")}
            </Button>
            {status.connected ? (
              <Button variant="tertiary" onClick={() => setEditing(false)} disabled={busy !== null}>
                {t2("tickets.panels.draft.cancel")}
              </Button>
            ) : null}
          </div>
          <p className={styles.help}>
            In Klaviyo: Settings → API keys → Create private API key, with <b>read-only</b> access to Metrics, Flows and
            Campaigns. The key is checked with Klaviyo, then stored encrypted; it is never shown again.
          </p>
        </form>
      ) : (
        <div className={styles.row}>
          <Button onClick={() => setEditing(true)} disabled={busy !== null}>
            {t2("settings.klaviyo.replace")}
          </Button>
          <Button variant="danger" loading={busy === "remove"} disabled={busy !== null} onClick={() => void send("DELETE")}>
            {t2("settings.klaviyo.remove")}
          </Button>
        </div>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
