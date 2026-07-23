"use client";

import type { Article, SaveState, ShopifySource } from "@/lib/types";
import type { KnowledgeCategory } from "@/lib/types";
import { RichTextEditor } from "./RichTextEditor";
import { SourcePageSelect } from "./SourcePageSelect";
import { CategorySelect } from "./CategorySelect";
import { WorkspaceActions } from "./WorkspaceActions";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { EditorFooter } from "./EditorFooter";
import { AlertIcon, CheckCircleIcon, RefreshIcon } from "@/components/icons";
import styles from "./ArticleWorkspace.module.css";

interface ArticleWorkspaceProps {
  article: Article;
  sources: ShopifySource[];
  saveState: SaveState;
  optimizing: boolean;
  deleting: boolean;
  wordCount: number;
  /** Bumped on programmatic content changes (import/optimize) to remount the editor. */
  editorVersion: number;
  /** Bumped when a new article is created, to move focus into the title field. */
  focusTitleNonce: number;
  onBack: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (html: string, wordCount: number) => void;
  onSourceChange: (sourceId: string | null) => void;
  onCategoryChange: (category: KnowledgeCategory) => void;
  onResync: () => void;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
}

export function ArticleWorkspace({
  article,
  sources,
  saveState,
  optimizing,
  deleting,
  wordCount,
  editorVersion,
  focusTitleNonce,
  onBack,
  onTitleChange,
  onContentChange,
  onSourceChange,
  onCategoryChange,
  onResync,
  onSave,
  onOptimize,
  onApprove,
  onUnapprove,
  onDelete,
}: ArticleWorkspaceProps) {
  const syncing = article.syncState === "syncing";
  // A source can only be attached once, to a genuinely fresh article — the
  // backend has no "reassign source" or "detach" path, only import (once)
  // and resync. Once a source is set, or the article has real content, the
  // picker locks; Resync is the only way to refresh from Shopify afterward.
  const sourceLocked = article.sourcePageId !== null || wordCount > 0;

  return (
    <div className={styles.workspace}>
      <div className={styles.editorCol}>
        <WorkspaceHeader
          article={article}
          placeholder="Untitled article"
          focusTitleNonce={focusTitleNonce}
          onBack={onBack}
          onTitleChange={onTitleChange}
        />

        <div className={styles.field}>
          <div className={styles.sourceRow}>
            <div className={styles.sourceSelect}>
              <label className={styles.label} id="source-label">
                Shopify source
              </label>
              <div aria-labelledby="source-label">
                <SourcePageSelect
                  sources={sources}
                  value={article.sourcePageId}
                  disabled={syncing || sourceLocked}
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
          {article.sourcePageId && (
            <p className={styles.syncWarning}>
              <AlertIcon size={14} />
              Editing this content will disconnect it from Shopify — it won&apos;t sync automatically after that.
            </p>
          )}
          <RichTextEditor
            key={`${article.id}:${editorVersion}`}
            articleId={article.id}
            initialHtml={article.content}
            placeholder="Write the guidance your agent should follow, or import a Shopify page above to start from its content."
            onChange={onContentChange}
          />
          <EditorFooter
            id="article-content-hint"
            wordCount={wordCount}
            saveState={saveState}
            updatedLabel={article.updatedLabel}
          />
        </div>
      </div>

      <div className={styles.rail}>
        <WorkspaceActions
          saveState={saveState}
          optimizing={optimizing}
          deleting={deleting}
          status={article.status}
          onSave={onSave}
          onOptimize={onOptimize}
          onApprove={onApprove}
          onUnapprove={onUnapprove}
          onDelete={onDelete}
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
