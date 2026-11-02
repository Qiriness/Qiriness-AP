"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormat, useT } from "@/lib/i18n/client";
import type { ChatCapsView } from "@/lib/server/storefront-agent/chat-caps-service";
import { Button } from "../ui/Button";
import styles from "./ChatCapsCard.module.css";

const ENDPOINT = "/api/storefront-agent/caps";

/**
 * The storefront chat's two caps for one shop (chat-caps.mjs): a number each,
 * empty for the default. The chat picks a change up within a minute.
 */
export function ChatCapsCard({ caps, showShop }: { caps: ChatCapsView; showShop: boolean }) {
  const tr = useT();
  const f = useFormat();
  const router = useRouter();
  const id = useId();
  const initial = { daily: caps.daily === null ? "" : String(caps.daily), session: caps.session === null ? "" : String(caps.session) };
  const [daily, setDaily] = useState(initial.daily);
  const [session, setSession] = useState(initial.session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const effectiveDaily = caps.daily ?? caps.defaults.daily;
  const changed = daily.trim() !== initial.daily || session.trim() !== initial.session;
  const editable = caps.storable && !caps.error;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: caps.shopDomain, daily: daily.trim(), session: session.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? tr("storefrontAgent.caps.failed", { status: response.status }));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError(tr("storefrontAgent.caps.unreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && changed && !busy) void save();
      }}
    >
      {showShop ? <p className={styles.shop}>{caps.shopDomain}</p> : null}
      <div className={styles.fields}>
        <label className={styles.field} htmlFor={`${id}-daily`}>
          <span className={styles.label}>{tr("storefrontAgent.caps.daily")}</span>
          <input
            id={`${id}-daily`}
            className={styles.input}
            type="number"
            inputMode="numeric"
            min={caps.bounds.daily.min}
            max={caps.bounds.daily.max}
            step={1}
            placeholder={String(caps.defaults.daily)}
            value={daily}
            disabled={!editable || busy}
            onChange={(event) => {
              setDaily(event.target.value);
              setSaved(false);
            }}
          />
          <span className={styles.help}>{tr("storefrontAgent.caps.dailyHelp", { default: f.integer(caps.defaults.daily) })}</span>
        </label>
        <label className={styles.field} htmlFor={`${id}-session`}>
          <span className={styles.label}>{tr("storefrontAgent.caps.session")}</span>
          <input
            id={`${id}-session`}
            className={styles.input}
            type="number"
            inputMode="numeric"
            min={caps.bounds.session.min}
            max={caps.bounds.session.max}
            step={1}
            placeholder={String(caps.defaults.session)}
            value={session}
            disabled={!editable || busy}
            onChange={(event) => {
              setSession(event.target.value);
              setSaved(false);
            }}
          />
          <span className={styles.help}>{tr("storefrontAgent.caps.sessionHelp", { default: f.integer(caps.defaults.session) })}</span>
        </label>
      </div>
      <p className={styles.usage}>
        {caps.usedLast24h === null
          ? tr("storefrontAgent.caps.usageUnknown")
          : tr("storefrontAgent.caps.usage", {
              used: f.integer(caps.usedLast24h),
              cap: f.integer(effectiveDaily),
              share: f.percent(caps.usedLast24h, Math.max(1, effectiveDaily), 0),
            })}
      </p>
      {caps.error ? <p className={styles.help}>{tr("storefrontAgent.caps.unreadable")}</p> : null}
      {!caps.error && !caps.storable ? <p className={styles.help}>{tr("storefrontAgent.caps.noShopRow")}</p> : null}
      {editable ? (
        <div className={styles.actions}>
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!changed || busy}>
            {tr("storefrontAgent.caps.save")}
          </Button>
          {saved ? (
            <span className={styles.saved} role="status">
              {tr("storefrontAgent.caps.saved")}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
