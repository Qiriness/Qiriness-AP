"use client";

import { useMemo } from "react";
import type { Article, ArticleStatus, CoreTopic, KnowledgeCategory } from "@/lib/types";
import { CATEGORY_LABELS, CORE_TOPICS, KNOWLEDGE_CATEGORIES, STATUS_LABELS } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ArticleListItem } from "./ArticleListItem";
import { CollapsibleSection } from "./CollapsibleSection";
import { CoreTopicPlaceholder } from "./CoreTopicPlaceholder";
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
  onCreateCoreTopic: (topic: CoreTopic) => void;
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
  onCreateCoreTopic,
  onClearFilters,
}: ArticleLibraryProps) {
  const isFiltering = query.trim() !== "" || statusFilter !== "all";

  // Core setup is a fixed checklist, not a filtered view — only meaningful
  // (and only accurate) when nothing is filtered out, since `articles` here
  // equals the full list exactly when query/statusFilter are at their
  // defaults. While filtering, core articles simply behave like any other
  // article instead of disappearing into a hidden section.
  const coreArticleByTopic = useMemo(() => {
    const map = new Map<CoreTopic, Article>();
    if (isFiltering) return map;
    for (const article of articles) {
      if (article.coreTopic && !map.has(article.coreTopic)) {
        map.set(article.coreTopic, article);
      }
    }
    return map;
  }, [articles, isFiltering]);

  // coreArticleByTopic can also hold the "brand" entry (see the Drafting
  // agent setup section below), which isn't part of CORE_TOPICS anymore — so
  // count only the topics actually in the checklist, not every map key.
  const coreFilledCount = CORE_TOPICS.filter((t) => coreArticleByTopic.has(t)).length;
  const coreComplete = coreFilledCount === CORE_TOPICS.length;
  const brandVoiceArticle = coreArticleByTopic.get("brand");

  const groupableArticles = useMemo(() => {
    if (coreArticleByTopic.size === 0) return articles;
    const coreIds = new Set([...coreArticleByTopic.values()].map((a) => a.id));
    return articles.filter((a) => !coreIds.has(a.id));
  }, [articles, coreArticleByTopic]);

  const categoryGroups = useMemo(() => {
    const groups = new Map<KnowledgeCategory, Article[]>();
    for (const article of groupableArticles) {
      const list = groups.get(article.category) ?? [];
      list.push(article);
      groups.set(article.category, list);
    }
    return groups;
  }, [groupableArticles]);

  // Only worth splitting into sections once articles actually span more than
  // one category — a single "Support" heading over every item adds a label
  // with no organizing value.
  const groupByCategory = categoryGroups.size >= 2;
  const orderedCategories = KNOWLEDGE_CATEGORIES.filter((c) => categoryGroups.has(c));

  const showEmptyState = isFiltering && articles.length === 0;

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

      {showEmptyState ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <KnowledgeIcon size={26} />
          </span>
          <p className={styles.emptyTitle}>No articles match</p>
          <p className={styles.emptyText}>
            {totalCount > 0
              ? "Try a different search or status filter."
              : "You have no articles yet."}
          </p>
          <Button variant="secondary" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div className={styles.list}>
          {!isFiltering && (
            <CollapsibleSection
              title="Drafting agent setup"
              meta={brandVoiceArticle ? "Configured" : "Not started"}
              defaultCollapsed={Boolean(brandVoiceArticle)}
            >
              {brandVoiceArticle ? (
                <ArticleListItem
                  article={brandVoiceArticle}
                  selected={brandVoiceArticle.id === selectedId}
                  onSelect={onSelect}
                />
              ) : (
                <CoreTopicPlaceholder topic="brand" onCreate={onCreateCoreTopic} />
              )}
            </CollapsibleSection>
          )}

          {!isFiltering && (
            <CollapsibleSection
              title="Core setup"
              meta={`${coreFilledCount} of ${CORE_TOPICS.length} started`}
              defaultCollapsed={coreComplete}
            >
              {CORE_TOPICS.map((topic) => {
                const article = coreArticleByTopic.get(topic);
                return article ? (
                  <ArticleListItem
                    key={topic}
                    article={article}
                    selected={article.id === selectedId}
                    onSelect={onSelect}
                  />
                ) : (
                  <CoreTopicPlaceholder key={topic} topic={topic} onCreate={onCreateCoreTopic} />
                );
              })}
            </CollapsibleSection>
          )}

          {!isFiltering && groupByCategory ? (
            <CollapsibleSection title="Articles" meta={`${groupableArticles.length}`}>
              {orderedCategories.map((category) => (
                <CollapsibleSection
                  key={category}
                  title={CATEGORY_LABELS[category]}
                  meta={`${categoryGroups.get(category)?.length ?? 0}`}
                >
                  {(categoryGroups.get(category) ?? []).map((article) => (
                    <ArticleListItem
                      key={article.id}
                      article={article}
                      selected={article.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                </CollapsibleSection>
              ))}
            </CollapsibleSection>
          ) : (
            <>
              {!isFiltering && groupableArticles.length > 0 && (
                <CollapsibleSection title="Articles" meta={`${groupableArticles.length}`}>
                  {groupableArticles.map((article) => (
                    <ArticleListItem
                      key={article.id}
                      article={article}
                      selected={article.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                </CollapsibleSection>
              )}
              {isFiltering &&
                articles.map((article) => (
                  <ArticleListItem
                    key={article.id}
                    article={article}
                    selected={article.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
            </>
          )}

          <button type="button" className={styles.createTile} onClick={onCreate}>
            <span className={styles.createTileIcon}>
              <PlusIcon size={18} />
            </span>
            <span className={styles.createTileText}>
              <span className={styles.createTileTitle}>Create a new article</span>
              <span className={styles.createTileSub}>Start from scratch or a Shopify page</span>
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
