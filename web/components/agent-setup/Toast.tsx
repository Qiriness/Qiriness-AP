import { AlertIcon, CheckCircleIcon, RefreshIcon } from "@/components/icons";
import styles from "./Toast.module.css";

export type ToastVariant = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  message: string;
  variant: ToastVariant;
}

const ICONS = {
  success: CheckCircleIcon,
  error: AlertIcon,
  info: RefreshIcon,
} as const;

/** Single transient toast. Announced politely (assertively for errors). */
export function Toast({ toast }: { toast: ToastMessage | null }) {
  return (
    <div
      className={styles.region}
      role="status"
      aria-live={toast?.variant === "error" ? "assertive" : "polite"}
    >
      {toast && <ToastCard key={toast.id} toast={toast} />}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastMessage }) {
  const Icon = ICONS[toast.variant];
  return (
    <div className={`${styles.toast} ${styles[toast.variant]}`}>
      <Icon size={18} className={styles.icon} />
      <span className={styles.message}>{toast.message}</span>
    </div>
  );
}
