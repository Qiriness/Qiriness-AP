"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, KnowledgeCategory, SaveState } from "@/lib/types";
import {
  DEMO_ARTICLES,
  DEMO_CONTEXT,
  SHOPIFY_PAGES,
} from "@/lib/demo-data";
import { SetupHeader } from "./SetupHeader";
import { ArticleLibrary, type StatusFilter } from "./ArticleLibrary";
import { ArticleWorkspace } from "./ArticleWorkspace";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { Toast, type ToastMessage, type ToastVariant } from "./Toast";
import styles from "./AgentSetup.module.css";

/** Simulated latencies for the demo interaction flows (no backend yet). */
const IMPORT_MS = 1100;
const SAVE_MS = 700;
const OPTIMIZE_MS = 1300;
const FAILING_PAGE_ID = "page-returns"; // demonstrates the import error path

function wordsIn(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function importedContentFor(title: string, handle: string): string {
  return (
    `<p>Imported from the Shopify page <strong>${title}</strong> (${handle}).</p>` +
    `<p>Review this draft and rewrite it in the Qiriness brand voice before approving it for the agent.</p>`
  );
}

function tidyContent(html: string): string {
  return html
    .replace(/<p>\s*(&nbsp;)?\s*<\/p>/g, "") // drop empty paragraphs
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function AgentSetup() {
  const [articles, setArticles] = useState<Article[]>(DEMO_ARTICLES);
  const [selectedId, setSelectedId] = useState<string | null>("art-refund");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [optimizing, setOptimizing] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [editorVersion, setEditorVersion] = useState<Record<string, number>>({});
  const [mobilePane, setMobilePane] = useState<"list" | "workspace">("list");
  const [focusNonce, setFocusNonce] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  function later(fn: () => void, ms: number) {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }

  function showToast(message: string, variant: ToastVariant = "success") {
    const id = ++toastId.current;
    setToast({ id, message, variant });
    later(() => setToast((t) => (t && t.id === id ? null : t)), 3200);
  }

  const selected = useMemo(
    () => articles.find((a) => a.id === selectedId) ?? null,
    [articles, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return articles.filter((a) => {
      const matchesQuery = q === "" || a.title.toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || a.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [articles, query, statusFilter]);

  const approvedCount = useMemo(
    () => articles.filter((a) => a.status === "approved").length,
    [articles],
  );

  const brandVoice = articles.find((a) => a.id === DEMO_CONTEXT.brandVoiceArticleId);

  // Recompute word count whenever the selected article changes.
  useEffect(() => {
    setWordCount(selected ? wordsIn(selected.content) : 0);
  }, [selectedId, selected]);

  function patchArticle(id: string, patch: Partial<Article>) {
    setArticles((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function bumpEditor(id: string) {
    setEditorVersion((v) => ({ ...v, [id]: (v[id] ?? 0) + 1 }));
  }

  function handleSelect(id: string) {
    if (id === selectedId) {
      setMobilePane("workspace");
      return;
    }
    setSelectedId(id);
    setSaveState("saved");
    setOptimizing(false);
    setMobilePane("workspace");
  }

  function handleTitleChange(title: string) {
    if (!selected) return;
    patchArticle(selected.id, { title });
    setSaveState("unsaved");
  }

  function handleContentChange(html: string, wc: number) {
    if (!selected) return;
    patchArticle(selected.id, { content: html });
    setWordCount(wc);
    setSaveState("unsaved");
  }

  function handleCategoryChange(category: KnowledgeCategory) {
    if (!selected) return;
    patchArticle(selected.id, { category });
    setSaveState("unsaved");
  }

  function handleSourceChange(pageId: string | null) {
    if (!selected || pageId === selected.sourcePageId) return;
    const id = selected.id;

    if (pageId === null) {
      patchArticle(id, { sourcePageId: null, syncState: "none" });
      setSaveState("unsaved");
      return;
    }

    patchArticle(id, { sourcePageId: pageId, syncState: "syncing" });
    setSaveState("unsaved");
    const page = SHOPIFY_PAGES.find((p) => p.id === pageId);

    later(() => {
      if (pageId === FAILING_PAGE_ID) {
        patchArticle(id, { syncState: "error" });
        showToast(`Couldn't import from ${page?.title ?? "Shopify"}.`, "error");
        return;
      }
      const current = articles.find((a) => a.id === id);
      const isEmpty = !current || wordsIn(current.content) === 0;
      const nextContent =
        isEmpty && page
          ? importedContentFor(page.title, page.handle)
          : undefined;
      patchArticle(id, {
        syncState: "synced",
        lastSyncedLabel: "just now",
        ...(nextContent ? { content: nextContent } : {}),
      });
      if (nextContent) bumpEditor(id);
      showToast(`Imported from ${page?.title ?? "Shopify"}.`);
    }, IMPORT_MS);
  }

  function handleResync() {
    if (!selected?.sourcePageId) return;
    const id = selected.id;
    const pageId = selected.sourcePageId;
    const page = SHOPIFY_PAGES.find((p) => p.id === pageId);
    patchArticle(id, { syncState: "syncing" });

    later(() => {
      if (pageId === FAILING_PAGE_ID) {
        patchArticle(id, { syncState: "error" });
        showToast(`Couldn't import from ${page?.title ?? "Shopify"}.`, "error");
        return;
      }
      patchArticle(id, { syncState: "synced", lastSyncedLabel: "just now" });
      showToast(`Resynced from ${page?.title ?? "Shopify"}.`);
    }, IMPORT_MS);
  }

  function handleSave() {
    if (!selected || saveState !== "unsaved") return;
    const id = selected.id;
    setSaveState("saving");
    later(() => {
      patchArticle(id, { updatedLabel: "just now" });
      setSaveState("saved");
      showToast("Draft saved.");
    }, SAVE_MS);
  }

  function handleOptimize() {
    if (!selected || optimizing) return;
    const id = selected.id;
    setOptimizing(true);
    later(() => {
      const current = articles.find((a) => a.id === id);
      const tidied = current ? tidyContent(current.content) : "";
      patchArticle(id, { content: tidied });
      bumpEditor(id);
      setWordCount(wordsIn(tidied));
      setOptimizing(false);
      setSaveState("unsaved");
      showToast("Draft tidied up — review before approving.", "info");
    }, OPTIMIZE_MS);
  }

  function handleApprove() {
    if (!selected || selected.status === "approved") return;
    patchArticle(selected.id, { status: "approved", updatedLabel: "just now" });
    setSaveState("saved");
    showToast("Approved for the agent.");
  }

  function handleCreate() {
    const id = `art-${Date.now()}`;
    const article: Article = {
      id,
      title: "",
      status: "draft",
      content: "",
      category: "general",
      sourcePageId: null,
      syncState: "none",
      updatedLabel: "just now",
    };
    setArticles((prev) => [article, ...prev]);
    setSelectedId(id);
    setQuery("");
    setStatusFilter("all");
    setSaveState("saved");
    setOptimizing(false);
    setMobilePane("workspace");
    setFocusNonce((n) => n + 1);
  }

  function handleClearFilters() {
    setQuery("");
    setStatusFilter("all");
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SetupHeader approved={approvedCount} total={articles.length} />

        <div className={styles.panes} data-pane={mobilePane}>
          <div className={styles.listPane}>
            <ArticleLibrary
              articles={filtered}
              totalCount={articles.length}
              query={query}
              statusFilter={statusFilter}
              selectedId={selectedId}
              onQueryChange={setQuery}
              onStatusFilterChange={setStatusFilter}
              onSelect={handleSelect}
              onCreate={handleCreate}
              onClearFilters={handleClearFilters}
            />
          </div>

          <div className={styles.workPane}>
            {selected ? (
              <ArticleWorkspace
                article={selected}
                pages={SHOPIFY_PAGES}
                saveState={saveState}
                optimizing={optimizing}
                wordCount={wordCount}
                editorVersion={editorVersion[selected.id] ?? 0}
                focusTitleNonce={focusNonce}
                brandVoiceTitle={brandVoice?.title || "Brand voice"}
                brandVoiceApproved={brandVoice?.status === "approved"}
                tone={DEMO_CONTEXT.tone}
                onBack={() => setMobilePane("list")}
                onTitleChange={handleTitleChange}
                onContentChange={handleContentChange}
                onSourceChange={handleSourceChange}
                onCategoryChange={handleCategoryChange}
                onResync={handleResync}
                onSave={handleSave}
                onOptimize={handleOptimize}
                onApprove={handleApprove}
              />
            ) : (
              <EmptyWorkspace onCreate={handleCreate} />
            )}
          </div>
        </div>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
