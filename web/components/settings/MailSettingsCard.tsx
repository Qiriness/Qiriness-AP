"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { ROLES } from "../../../scripts/lib/dashboard-auth.mjs";
import { Button } from "../ui/Button";
import base from "./KlaviyoKeyCard.module.css";
import styles from "./MailSettingsCard.module.css";

const ENDPOINT = "/api/settings/integrations/mail";

export type MailKind = "sales_report" | "stock_alert";
export type MailRecipient = { role: string } | { email: string };
export interface MailSetting {
  sender: string | null;
  recipients: MailRecipient[];
}

/**
 * Who one of this shop's automatic mails comes from and goes to
 * (scripts/lib/shop-mail-settings.mjs). « Sent to » holds dashboard roles —
 * every active account with that role when the mail goes — and any address.
 * Nothing is saved until Save; the server checks every address. `shop` is the
 * slug of the shop on screen, named on every call (integration-shop.ts).
 */
export function MailSettingsCard({ kind, initial, shop }: { kind: MailKind; initial: MailSetting; shop: string }) {
  const t = useT();
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [sender, setSender] = useState(initial.sender ?? "");
  const [recipients, setRecipients] = useState<MailRecipient[]>(initial.recipients);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = new Set(recipients.flatMap((r) => ("role" in r ? [r.role] : [])));
  const changed = JSON.stringify({ s: sender.trim().toLowerCase(), r: recipients }) !== JSON.stringify({ s: saved.sender ?? "", r: saved.recipients });
  const ready = Boolean(saved.sender) && saved.recipients.length > 0;

  function addEmail() {
    const value = email.trim().toLowerCase();
    if (!value) return;
    if (!recipients.some((r) => "email" in r && r.email === value)) setRecipients([...recipients, { email: value }]);
    setEmail("");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${ENDPOINT}?shop=${encodeURIComponent(shop)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, sender, recipients }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t("settings.mail.failed", { status: response.status }));
        return;
      }
      setSaved(payload as MailSetting);
      setSender(payload.sender ?? "");
      setRecipients(payload.recipients ?? []);
      router.refresh();
    } catch {
      setError(t("settings.mail.unreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={base.card}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className={base.help}>{t(`settings.mail.${kind}.what`)}</p>

      <div className={base.form}>
        <label className={base.label} htmlFor={`${kind}-sender`}>
          {t("settings.mail.from")}
        </label>
        <input
          id={`${kind}-sender`}
          className={base.input}
          type="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="contact@…"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
        />
      </div>

      <div className={base.form}>
        <span className={base.label}>{t("settings.mail.to")}</span>
        {recipients.length ? (
          <ul className={styles.chips}>
            {recipients.map((r) => {
              const key = "role" in r ? `role:${r.role}` : `email:${r.email}`;
              const label = "role" in r ? t("settings.mail.everyRole", { role: t(`role.${r.role}`) }) : r.email;
              return (
                <li key={key} className={`${styles.chip} ${"role" in r ? styles.roleChip : ""}`}>
                  <span>{label}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={t("settings.mail.remove", { who: label })}
                    onClick={() => setRecipients(recipients.filter((x) => x !== r))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={base.help}>{t("settings.mail.nobody")}</p>
        )}
        <div className={base.row}>
          <select
            className={styles.select}
            value=""
            aria-label={t("settings.mail.addRole")}
            onChange={(event) => {
              const role = event.target.value;
              if (role && !roles.has(role)) setRecipients([{ role }, ...recipients]);
            }}
          >
            <option value="">{t("settings.mail.addRole")}</option>
            {(ROLES as readonly string[]).filter((role) => !roles.has(role)).map((role) => (
              <option key={role} value={role}>
                {t("settings.mail.everyRole", { role: t(`role.${role}`) })}
              </option>
            ))}
          </select>
          <input
            className={base.input}
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.mail.addEmail")}
            aria-label={t("settings.mail.addEmail")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addEmail();
              }
            }}
          />
          <Button onClick={addEmail} disabled={!email.trim()}>
            {t("settings.mail.add")}
          </Button>
        </div>
      </div>

      <div className={base.row}>
        <Button type="submit" variant="primary" loading={busy} disabled={!changed || busy}>
          {t("settings.mail.save")}
        </Button>
        <span className={ready ? base.connected : base.failed}>{ready ? t("settings.mail.on") : t("settings.mail.off")}</span>
      </div>
      {error ? (
        <p className={base.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
