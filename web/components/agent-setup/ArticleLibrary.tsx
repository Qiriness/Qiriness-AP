"use client";

import { useMemo } from "react";
import type { Article, ArticleStatus, CoreTopic, KnowledgeCategory } from "@/lib/types";
import { KNOWLEDGE_CATEGORIES } from "@/lib/types";
import { useT } from "@/lib/i18n/client";
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
  const t = useT();
  const isFiltering = query.trim() !== "" || statusFilter !== "all";

  // THE BRAND VOICE is the one fixed slot left: every draft is written with it,
  // so it sits in its own section. The old « Core setup » checklist (order
  // policies, delivery & returns, confidentiality…) is gone: the company's
  // policies live in Agent Setup → Policies now. Only meaningful while nothing
  // is filtered; while filtering, the brand voice behaves like any article.
  const brandVoiceArticle = useMemo(
    () => (isFiltering ? undefined : articles.find((article) => article.coreTopic === "brand")),
    [articles, isFiltering]
  );

  const groupableArticles = useMemo(
    () => (brandVoiceArticle ? articles.filter((a) => a.id !== brandVoiceArticle.id) : articles),
    [articles, brandVoiceArticle]
  );

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
  // Named FAQs first, then General FAQ, then Brand story — the list order.
  const orderedCategories = KNOWLEDGE_CATEGORIES.filter((c) => categoryGroups.has(c));

  const showEmptyState = isFiltering && articles.length === 0;

  return (
    <section className={styles.library} aria-label={t("setup.knowledge.articles")}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t("setup.knowledge.articles")}</h2>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<PlusIcon size={16} />}
          onClick={onCreate}
        >
          {t("setup.knowledge.create")}
        </Button>
      </div>

      <div className={styles.search}>
        <SearchIcon size={17} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder={t("setup.knowledge.searchArticles")}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label={t("setup.knowledge.searchArticles")}
        />
      </div>

      <div className={styles.filters} role="group" aria-label={t("setup.knowledge.filterStatus")}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.filter} ${statusFilter === f ? styles.filterOn : ""}`}
            aria-pressed={statusFilter === f}
            onClick={() => onStatusFilterChange(f)}
          >
            {f === "all" ? t("setup.knowledge.all") : t(`articleStatus.${f}`)}
          </button>
        ))}
      </div>

      {showEmptyState ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <KnowledgeIcon size={26} />
          </span>
          <p className={styles.emptyTitle}>{t("setup.knowledge.noMatch")}</p>
          <p className={styles.emptyText}>
            {totalCount > 0
              ? t("setup.knowledge.tryDifferent")
              : t("setup.knowledge.noneYet")}
          </p>
          <Button variant="secondary" size="sm" onClick={onClearFilters}>
            {t("setup.knowledge.clearFilters")}
          </Button>
        </div>
      ) : (
        <div className={styles.list}>
          {!isFiltering && (
            <CollapsibleSection
              title={t("setup.knowledge.draftingSetup")}
              meta={
                brandVoiceArticle
                  ? brandVoiceArticle.status === "approved"
                    ? t("setup.knowledge.configured")
                    : t(`articleStatus.${brandVoiceArticle.status}`)
                  : t("setup.knowledge.notStarted")
              }
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

          {!isFiltering && groupByCategory ? (
            <CollapsibleSection title={t("setup.knowledge.articlesGroup")} meta={`${groupableArticles.length}`}>
              {orderedCategories.map((category) => (
                <CollapsibleSection
                  key={category}
                  title={t(`articleCategory.${category}`)}
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
                <CollapsibleSection title={t("setup.knowledge.articlesGroup")} meta={`${groupableArticles.length}`}>
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
              <span className={styles.createTileTitle}>{t("setup.knowledge.createNew")}</span>
              <span className={styles.createTileSub}>{t("setup.knowledge.createSub")}</span>
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
