import type { ArticleStatus } from "@/lib/types";
import { Tx } from "@/lib/i18n/client";
import {
  AlertIcon,
  CheckCircleIcon,
  ClockIcon,
  DotIcon,
  SparkleIcon,
} from "@/components/icons";
import styles from "./StatusChip.module.css";

const ICONS: Record<ArticleStatus, typeof DotIcon> = {
  draft: DotIcon,
  in_review: ClockIcon,
  approved: CheckCircleIcon,
  needs_optimization: SparkleIcon,
};

interface StatusChipProps {
  status: ArticleStatus;
  size?: "sm" | "md";
}

/** Compact status pill. Semantic colors, never brand teal, so state stays legible. */
export function StatusChip({ status, size = "sm" }: StatusChipProps) {
  const Icon = ICONS[status];
  return (
    <span className={[styles.chip, styles[status], styles[size]].join(" ")}>
      <Icon size={size === "sm" ? 13 : 15} className={styles.icon} />
      <Tx k={`articleStatus.${status}`} />
    </span>
  );
}

/** Small red inline marker for the Shopify import error state. */
export function ErrorChip({ label = "setup.knowledge.importFailed" }: { label?: string }) {
  return (
    <span className={[styles.chip, styles.error, styles.sm].join(" ")}>
      <AlertIcon size={13} className={styles.icon} />
      <Tx k={label} />
    </span>
  );
}
