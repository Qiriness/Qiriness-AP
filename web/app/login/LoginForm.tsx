"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./login.module.css";

/**
 * Email + password, posted as JSON to /api/auth/login. On success the route
 * has set the session cookie; a full navigation (not router.push) makes every
 * server component render again with it.
 */
export function LoginForm({ next }: { next: string }) {
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
        setError(body?.error ?? "Sign-in failed. Try again.");
        setPassword("");
        setBusy(false);
        return;
      }
      window.location.assign(body?.next ?? next);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label className={styles.field}>
        <span className={styles.label}>Email</span>
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
        <span className={styles.label}>Password</span>
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
        Sign in
      </Button>
      <p className={styles.help}>No account, or forgot your password? Ask a developer on the team.</p>
    </form>
  );
}
