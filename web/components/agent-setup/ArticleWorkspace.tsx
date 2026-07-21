"use client";

import { useEffect, useRef } from "react";
import type { Article, SaveState, ShopifyPage } from "@/lib/types";
import type { KnowledgeCategory } from "@/lib/types";
import { StatusChip } from "@/components/ui/StatusChip";
import { RichTextEditor } from "./RichTextEditor";
import { SourcePageSelect } from "./SourcePageSelect";
import { CategorySelect } from "./CategorySelect";
import { ContextSummary } from "./ContextSummary";
import { WorkspaceActions } from "./WorkspaceActions";
import {
  AlertIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  RefreshIcon,
} from "@/components/icons";
import styles from "./ArticleWorkspace.module.css";

interface ArticleWorkspaceProps {
  article: Article;
  pages: ShopifyPage[];
  saveState: SaveState;
  optimizing: boolean;
  wordCount: number;
  /** Bumped on programmatic content changes (import/optimize) to remount the editor. */
  editorVersion: number;
  /** Bumped when a new article is created, to move focus into the title field. */
  focusTitleNonce: number;
  brandVoiceTitle: string;
  brandVoiceApproved: boolean;
  tone: string[];
  onBack: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (html: string, wordCount: number) => void;
  onSourceChange: (pageId: string | null) => void;
  onCategoryChange: (category: KnowledgeCategory) => void;
  onResync: () => void;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
}

export function ArticleWorkspace({
  article,
  pages,
  saveState,
  optimizing,
  wordCount,
  editorVersion,
  focusTitleNonce,
  brandVoiceTitle,
  brandVoiceApproved,
  tone,
  onBack,
  onTitleChange,
  onContentChange,
  onSourceChange,
  onCategoryChange,
  onResync,
  onSave,
  onOptimize,
  onApprove,
}: ArticleWorkspaceProps) {
  const syncing = article.syncState === "syncing";
  const titleRef = useRef<HTMLInputElement>(null);

  // Move focus into the title when a fresh article is created.
  useEffect(() => {
    if (focusTitleNonce > 0) titleRef.current?.focus();
  }, [focusTitleNonce]);

  return (
    <div className={styles.workspace}>
      <div className={styles.editorCol}>
        <div className={styles.topRow}>
          <button
            type="button"
            className={styles.back}
            onClick={onBack}
            aria-label="Back to article list"
          >
            <ChevronLeftIcon size={18} />
          </button>
          <label className={styles.titleField}>
            <span className="sr-only">Article title</span>
            <input
              ref={titleRef}
              type="text"
              className={styles.titleInput}
              value={article.title}
              placeholder="Untitled article"
              onChange={(e) => onTitleChange(e.target.value)}
              maxLength={120}
            />
          </label>
          <StatusChip status={article.status} size="md" />
        </div>

        <div className={styles.field}>
          <div className={styles.sourceRow}>
            <div className={styles.sourceSelect}>
              <label className={styles.label} id="source-label">
                Shopify source page
              </label>
              <div aria-labelledby="source-label">
                <SourcePageSelect
                  pages={pages}
                  value={article.sourcePageId}
                  disabled={syncing}
                  onChange={onSourceChange}
                />
              </div>
            </div>
            <div className={styles.syncState}>
              <SyncIndicator
                article={article}
                onResync={onResync}
              />
            </div>
          </div>

          <div className={styles.categoryRow}>
            <label className={styles.label} id="category-label">
              Category
            </label>
            <div aria-labelledby="category-label">
              <CategorySelect value={article.category} onChange={onCategoryChange} />
            </div>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="article-content-hint">
            Article content
          </label>
          <RichTextEditor
            key={`${article.id}:${editorVersion}`}
            articleId={article.id}
            initialHtml={article.content}
            placeholder="Write the guidance your agent should follow, or import a Shopify page above to start from its content."
            onChange={onContentChange}
          />
          <div className={styles.editorFooter} id="article-content-hint">
            <span className={styles.wordCount}>
              {wordCount} {wordCount === 1 ? "word" : "words"}
            </span>
            <SaveIndicator saveState={saveState} updatedLabel={article.updatedLabel} />
          </div>
        </div>
      </div>

      <div className={styles.rail}>
        <ContextSummary
          brandVoiceTitle={brandVoiceTitle}
          brandVoiceApproved={brandVoiceApproved}
          tone={tone}
        />
        <WorkspaceActions
          saveState={saveState}
          optimizing={optimizing}
          status={article.status}
          onSave={onSave}
          onOptimize={onOptimize}
          onApprove={onApprove}
        />
      </div>
    </div>
  );
}

function SyncIndicator({
  article,
  onResync,
}: {
  article: Article;
  onResync: () => void;
}) {
  if (!article.sourcePageId) {
    return <span className={styles.syncMuted}>No source linked</span>;
  }
  if (article.syncState === "syncing") {
    return (
      <span className={styles.syncing}>
        <span className={styles.spinner} aria-hidden="true" />
        Importing…
      </span>
    );
  }
  if (article.syncState === "error") {
    return (
      <span className={styles.syncBlock}>
        <span className={styles.syncError}>
          <AlertIcon size={15} />
          Import failed
        </span>
        <button type="button" className={styles.resync} onClick={onResync}>
          <RefreshIcon size={14} />
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className={styles.syncBlock}>
      <span className={styles.synced}>
        <CheckCircleIcon size={15} />
        Synced
      </span>
      <span className={styles.syncMeta}>
        {article.lastSyncedLabel ? `Last synced ${article.lastSyncedLabel}` : ""}
      </span>
      <button type="button" className={styles.resync} onClick={onResync}>
        <RefreshIcon size={14} />
        Resync
      </button>
    </span>
  );
}

function SaveIndicator({
  saveState,
  updatedLabel,
}: {
  saveState: SaveState;
  updatedLabel: string;
}) {
  if (saveState === "saving") {
    return (
      <span className={styles.saveState}>
        <span className={`${styles.saveDot} ${styles.saveDotBusy}`} aria-hidden="true" />
        Saving…
      </span>
    );
  }
  if (saveState === "unsaved") {
    return (
      <span className={styles.saveState}>
        <span className={styles.saveDot} aria-hidden="true" />
        Unsaved changes
      </span>
    );
  }
  return (
    <span className={`${styles.saveState} ${styles.saved}`}>
      <CheckCircleIcon size={14} />
      Saved {updatedLabel}
    </span>
  );
}
