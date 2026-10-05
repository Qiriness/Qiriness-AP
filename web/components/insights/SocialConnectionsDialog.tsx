"use client";

import { useT } from "@/lib/i18n/client";
import type { SocialConnectionsStatus } from "@/lib/social-types";
import { Dialog } from "../ui/Dialog";
import { SocialProviderCards } from "./SocialProviderCard";
import styles from "./SocialView.module.css";

/**
 * Connections: Meta and Google Ads, then the networks not built yet. Opened
 * from the panel (`?connections=1`); the provider sends the person back here
 * with `connected=` or `connect_error=`, which is the notice at the top.
 */
export function SocialConnectionsDialog({
  initial,
  returnKey,
  notice,
  onClose,
}: {
  initial: SocialConnectionsStatus;
  returnKey: "social" | "settings";
  notice: { ok: true; provider: string } | { ok: false; code: string; provider: string | null } | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog title={t("insights.social.connections.title")} meta={t("insights.social.connections.meta")} closeLabel={t("insights.social.connections.close")} onClose={onClose}>
      <div className={styles.dialogBody}>
        {notice ? <SocialNotice notice={notice} /> : null}
        <SocialProviderCards initial={initial} returnKey={returnKey} />
      </div>
    </Dialog>
  );
}

const CODES = ["denied", "state", "not_configured", "no_accounts", "exchange_failed", "unknown"];
const knownCode = (code: string) => (CODES.includes(code) ? code : "exchange_failed");

/** What the provider's redirect back said: connected, or why not — a short code, worded here. */
export function SocialNotice({ notice }: { notice: { ok: true; provider: string } | { ok: false; code: string; provider: string | null } }) {
  const t = useT();
  const provider = (key: string | null) => (key === "meta" || key === "google" ? t(`insights.social.provider.${key}`) : "");
  return (
    <p className={notice.ok ? styles.noticeOk : styles.noticeBad} role="status">
      {notice.ok
        ? t("insights.social.connect.ok", { provider: provider(notice.provider) })
        : t(`insights.social.connect.error.${knownCode(notice.code)}`, { provider: provider(notice.provider) })}
    </p>
  );
}
