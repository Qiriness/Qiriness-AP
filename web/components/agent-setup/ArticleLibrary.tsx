"use client";

import type { Article, ArticleStatus } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ArticleListItem } from "./ArticleListItem";
import { KnowledgeIcon, PlusIcon, SearchIcon } from "@/components/icons";
import styles from "./ArticleLibrary.module.css";

export type StatusFilter = "all" | ArticleStatus;

const FILTERS: StatusFilter[] = [
  "all",
  "draft",
  "needs_optimization",
  "in_review",
  "approved",
];

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All",
  ...STATUS_LABELS,
};

interface ArticleLibraryProps {
  articles: Article[];
  totalCount: number;
  query: string;
  statusFilter: StatusFilter;
  selectedId: string | null;
  onQueryChange: (q: string) => void;
  onStatusFilterChange: (f: StatusFilter) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClearFilters: () => void;
}

export function ArticleLibrary({
  articles,
  totalCount,
  query,
  statusFilter,
  selectedId,
  onQueryChange,
  onStatusFilterChange,
  onSelect,
  onCreate,
  onClearFilters,
}: ArticleLibraryProps) {
  const isFiltering = query.trim() !== "" || statusFilter !== "all";

  return (
    <section className={styles.library} aria-label="Knowledge articles">
      <div className={styles.head}>
        <h2 className={styles.title}>Knowledge articles</h2>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<PlusIcon size={16} />}
          onClick={onCreate}
        >
          Create article
        </Button>
      </div>

      <div className={styles.search}>
        <SearchIcon size={17} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search articles"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search articles"
        />
      </div>

      <div className={styles.filters} role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.filter} ${statusFilter === f ? styles.filterOn : ""}`}
            aria-pressed={statusFilter === f}
            onClick={() => onStatusFilterChange(f)}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {articles.length > 0 ? (
        <>
          <ul className={styles.list}>
            {articles.map((article) => (
              <ArticleListItem
                key={article.id}
                article={article}
                selected={article.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
          <button type="button" className={styles.createTile} onClick={onCreate}>
            <span className={styles.createTileIcon}>
              <PlusIcon size={18} />
            </span>
            <span className={styles.createTileText}>
              <span className={styles.createTileTitle}>Create a new article</span>
              <span className={styles.createTileSub}>Start from scratch or a Shopify page</span>
            </span>
          </button>
        </>
      ) : (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <KnowledgeIcon size={26} />
          </span>
          {isFiltering ? (
            <>
              <p className={styles.emptyTitle}>No articles match</p>
              <p className={styles.emptyText}>
                {totalCount > 0
                  ? "Try a different search or status filter."
                  : "You have no articles yet."}
              </p>
              <Button variant="secondary" size="sm" onClick={onClearFilters}>
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <p className={styles.emptyTitle}>No articles yet</p>
              <p className={styles.emptyText}>
                Add brand voice, policies, and FAQs to shape what your agent knows.
              </p>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<PlusIcon size={16} />}
                onClick={onCreate}
              >
                Create your first article
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
