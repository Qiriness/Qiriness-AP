import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { getT } from "@/lib/i18n/server";
import { LoginForm } from "./LoginForm";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · Qiriness Support OS",
};

/** The one page open to everyone. Already signed in? Straight on to where you were going. */
export default async function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNextPath(searchParams.next);
  if (await getSession()) redirect(next);
  const t = getT();

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>Qiriness</span>
          <span className={styles.brandSub}>Support&nbsp;OS</span>
        </div>
        <h1 className={styles.title}>{t("login.signIn")}</h1>
        <p className={styles.lede}>{t("login.lede")}</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
