import type { Article } from "@/lib/types";
import { StatusChip } from "@/components/ui/StatusChip";
import { AlertIcon, ChevronRightIcon, PageIcon } from "@/components/icons";
import { Tx } from "@/lib/i18n/client";
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
            {article.title || <Tx k="setup.knowledge.untitled" />}
          </span>
          <StatusChip status={article.status} />
        </span>
        <span className={styles.meta}>
          {article.sourcePageId ? (
            <span className={styles.source}>
              <PageIcon size={13} />
              <Tx k="setup.knowledge.shopifySource" />
            </span>
          ) : (
            <span className={styles.source}><Tx k="setup.knowledge.standalone" /></span>
          )}
          <span className={styles.dot} aria-hidden="true">
            ·
          </span>
          <span><Tx k="setup.knowledge.updated" params={{ when: article.updatedLabel }} /></span>
          {article.syncState === "error" && (
            <span className={styles.syncError}>
              <AlertIcon size={13} />
              <Tx k="setup.knowledge.syncFailed" />
            </span>
          )}
        </span>
      </span>
      <ChevronRightIcon size={16} className={styles.chevron} />
    </button>
  );
}
