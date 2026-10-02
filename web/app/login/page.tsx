import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { getShop } from "@/lib/server/shop";
import { getT } from "@/lib/i18n/server";
import { LoginForm } from "./LoginForm";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
};

/** The one page open to everyone. Already signed in? Straight on to where you were going. */
export default async function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNextPath(searchParams.next);
  if (await getSession()) redirect(next);
  const t = getT();
  const shopName = (await getShop().catch(() => null))?.shopName ?? null;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          {/* The shop's name from `shops`; it was a literal. Absent before the first sync. */}
          {shopName && <span className={styles.wordmark}>{shopName}</span>}
          <span className={styles.brandSub}>Support&nbsp;OS</span>
        </div>
        <h1 className={styles.title}>{t("login.signIn")}</h1>
        <p className={styles.lede}>{t("login.lede")}</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
