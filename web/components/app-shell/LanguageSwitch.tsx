"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useT } from "@/lib/i18n/client";
import { SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/locales";
import styles from "./UserMenu.module.css";

/**
 * The FR | EN choice, shared by the user menu and the Settings page.
 *
 * The language asked for shows as chosen the moment it is clicked and stays so
 * until the refreshed page (in the new language) has arrived; the buttons are
 * disabled meanwhile and a spinner says the click registered. `onBusyChange`
 * lets the caller show its own sign of it (the avatar, in the menu).
 */
export function LanguageSwitch({
  showLabel = true,
  onBusyChange,
}: {
  showLabel?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [langError, setLangError] = useState(false);
  const [target, setTarget] = useState<Locale | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const switching = target !== null;

  // The switch ends when the new language has rendered (the locale changed).
  useEffect(() => setTarget(null), [locale]);
  useEffect(() => onBusyChange?.(switching), [switching, onBusyChange]);

  async function chooseLocale(next: Locale) {
    if (next === locale || switching) return;
    setLangError(false);
    setTarget(next);
    const response = await fetch("/api/preferences/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    }).catch(() => null);
    if (!response?.ok) {
      setTarget(null);
      return setLangError(true);
    }
    startRefresh(() => router.refresh());
  }

  return (
    <>
      <div className={styles.langRow} role="group" aria-label={t("common.language")} aria-busy={switching || refreshing}>
        {showLabel && <span className={styles.langLabel}>{t("common.language")}</span>}
        {SUPPORTED_LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            className={`${styles.langOption} ${code === (target ?? locale) ? styles.langActive : ""}`}
            aria-pressed={code === (target ?? locale)}
            disabled={switching}
            onClick={() => chooseLocale(code)}
          >
            {code === target ? <span className={styles.spinner} aria-hidden="true" /> : null}
            {showLabel ? code.toUpperCase() : t(`lang.${code}`)}
          </button>
        ))}
      </div>
      {switching && (
        <span className={styles.langStatus} role="status">
          {t("lang.switching")}
        </span>
      )}
      {langError && <span className={styles.langError}>{t("lang.switchFailed")}</span>}
    </>
  );
}
