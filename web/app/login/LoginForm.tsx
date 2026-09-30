"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/client";
import styles from "./login.module.css";

/**
 * Email + password, posted as JSON to /api/auth/login. On success the route
 * has set the session cookie; a full navigation (not router.push) makes every
 * server component render again with it.
 */
/** The route's own English sentences, mapped to words in the reader's language; anything else prints as it came. */
const KNOWN_ERRORS: Record<string, string> = {
  "Email or password is incorrect.": "login.errors.incorrect",
  "Too many attempts. Wait fifteen minutes and try again.": "login.errors.tooMany",
  "Sign-in is not configured on this server.": "login.errors.notConfigured",
};

export function LoginForm({ next }: { next: string }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ? t(KNOWN_ERRORS[body.error] ?? body.error) : t("login.errors.failed"));
        setPassword("");
        setBusy(false);
        return;
      }
      window.location.assign(body?.next ?? next);
    } catch {
      setError(t("login.errors.unreachable"));
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label className={styles.field}>
        <span className={styles.label}>{t("tickets.panels.row.email")}</span>
        <input
          className={styles.input}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t("login.password")}</span>
        <input
          className={styles.input}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>
        {t("login.signIn")}
      </Button>
      <p className={styles.help}>{t("login.help")}</p>
    </form>
  );
}
