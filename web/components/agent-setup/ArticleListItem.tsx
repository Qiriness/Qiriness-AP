import type { Article } from "@/lib/types";
import { StatusChip } from "@/components/ui/StatusChip";
import { AlertIcon, ChevronRightIcon, PageIcon } from "@/components/icons";
import styles from "./ArticleListItem.module.css";

interface ArticleListItemProps {
  article: Article;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function ArticleListItem({
  article,
  selected,
  onSelect,
}: ArticleListItemProps) {
  return (
    <li>
      <button
        type="button"
        className={`${styles.item} ${selected ? styles.selected : ""}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(article.id)}
      >
        <span className={styles.body}>
          <span className={styles.titleRow}>
            <span
              className={`${styles.title} ${article.title ? "" : styles.untitled}`}
            >
              {article.title || "Untitled article"}
            </span>
            <StatusChip status={article.status} />
          </span>
          <span className={styles.meta}>
            {article.sourcePageId ? (
              <span className={styles.source}>
                <PageIcon size={13} />
                Shopify source
              </span>
            ) : (
              <span className={styles.source}>Standalone</span>
            )}
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span>Updated {article.updatedLabel}</span>
            {article.syncState === "error" && (
              <span className={styles.syncError}>
                <AlertIcon size={13} />
                Sync failed
              </span>
            )}
          </span>
        </span>
        <ChevronRightIcon size={16} className={styles.chevron} />
      </button>
    </li>
  );
}
