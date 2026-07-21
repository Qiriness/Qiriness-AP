import { AlertIcon } from "@/components/icons";
import styles from "./LoadError.module.css";

interface LoadErrorProps {
  message: string;
}

/** Shown when the initial server-side fetch of articles/sources fails — a real backend/config problem, not an empty state. */
export function LoadError({ message }: LoadErrorProps) {
  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <span className={styles.icon}>
          <AlertIcon size={26} />
        </span>
        <h1 className={styles.title}>Couldn&apos;t load Agent Setup</h1>
        <p className={styles.message}>{message}</p>
        <p className={styles.hint}>
          Check that <code>web/.env.local</code> has Supabase and Shopify credentials, and that a
          Shopify sync script has run at least once so a shop record exists.
        </p>
      </div>
    </div>
  );
}
