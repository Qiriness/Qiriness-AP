"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { KlaviyoStatus } from "@/lib/server/integrations-service";
import { Button } from "../ui/Button";
import t from "../insights/tables.module.css";
import styles from "./KlaviyoKeyCard.module.css";

const ENDPOINT = "/api/settings/integrations/klaviyo";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : null;

/**
 * Where the Klaviyo private key is pasted. The field is write-only: once saved
 * the key is shown as its last four characters and can be replaced or removed,
 * never read. The server checks it against Klaviyo before storing it, so a
 * typo is refused here rather than failing the next nightly.
 */
export function KlaviyoKeyCard({ status }: { status: KlaviyoStatus }) {
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
        setError(payload?.error ?? `Failed (HTTP ${response.status})`);
        return;
      }
      setKey("");
      setEditing(method === "DELETE");
      router.refresh();
    } catch {
      setError("The dashboard could not be reached.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.card}>
      {status.connected ? (
        <dl className={styles.facts}>
          <dt>Private key</dt>
          <dd>
            <span className={styles.key}>pk_…{status.keyHint}</span>
            <span className={styles.connected}>Connected</span>
          </dd>
          <dt>Saved</dt>
          <dd>{when(status.savedAt)}</dd>
          <dt>Last sync</dt>
          <dd>
            {status.lastSyncAt ? (
              <>
                {when(status.lastSyncAt)}{" "}
                <span className={status.lastSyncStatus === "failed" ? styles.failed : styles.ok}>
                  {status.lastSyncStatus === "failed" ? "Failed" : "OK"}
                </span>
                {status.lastSyncError ? <span className={t.sub}>{status.lastSyncError}</span> : null}
              </>
            ) : (
              <span className={t.muted}>Not yet — flows and campaigns arrive with the next nightly sync</span>
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
            {status.connected ? "Replace the private key" : "Private API key"}
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
              Check and save
            </Button>
            {status.connected ? (
              <Button variant="tertiary" onClick={() => setEditing(false)} disabled={busy !== null}>
                Cancel
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
            Replace key
          </Button>
          <Button variant="danger" loading={busy === "remove"} disabled={busy !== null} onClick={() => void send("DELETE")}>
            Remove key
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
